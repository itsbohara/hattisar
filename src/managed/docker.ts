import { networkInterfaces } from "node:os";
import Docker from "dockerode";
import { ConfigError } from "../config.js";
import { type NetworkSummary, networkFor } from "./network.js";

export const MANAGED_LABEL = "hattisar.managed";
export const BOX_LABEL = "hattisar.box";
const MANAGED_FILTER = `${MANAGED_LABEL}=true`;
const POSTGRES_PORT = "5432/tcp";
const DATA_DIR = "/var/lib/postgresql/data";

export class UnmanagedObjectError extends Error {
  override name = "UnmanagedObjectError";
}

export interface ContainerSpec {
  name: string;
  box: string;
  image: string;
  volume: string;
  network: string;
  hostPort: number;
  env: Record<string, string>;
}

// What the service needs from Docker; ManagedDocker is the real one, tests may substitute.
export interface DockerApi {
  ensureImage(image: string): Promise<void>;
  ownNetwork(): Promise<string>;
  publishedPorts(): Promise<number[]>;
  createVolume(name: string, box: string): Promise<void>;
  createContainer(spec: ContainerSpec): Promise<void>;
  start(name: string, box: string): Promise<void>;
  stop(name: string, box: string): Promise<void>;
  removeContainer(name: string, box: string): Promise<void>;
  removeVolume(name: string, box: string): Promise<void>;
}

export function managedLabels(box: string): Record<string, string> {
  return { [MANAGED_LABEL]: "true", [BOX_LABEL]: box };
}

function statusCode(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : undefined;
}

export function dockerMessage(error: unknown): string {
  const json = (error as { json?: { message?: unknown } } | null)?.json;
  if (typeof json?.message === "string") return json.message;
  return error instanceof Error ? error.message : String(error);
}

export function isPortConflict(error: unknown): boolean {
  return /port is already allocated|address already in use/i.test(dockerMessage(error));
}

function ownLabels(kind: string, name: string, box: string, labels: Record<string, string>): void {
  if (labels[MANAGED_LABEL] !== "true" || labels[BOX_LABEL] !== box) {
    throw new UnmanagedObjectError(
      `${kind} ${name} is not labelled ${MANAGED_FILTER} for box ${box}; hattisar will not touch it`,
    );
  }
}

function ipv4Addresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address),
  );
}

// Plain http: the socket proxy listens only on the compose network and publishes no port.
export function dockerFromHost(dockerHost: string): Docker {
  const url = new URL(dockerHost);
  if (url.protocol !== "tcp:") throw new ConfigError("DOCKER_HOST must be a tcp:// URL");
  return new Docker({ host: url.hostname, port: Number(url.port || 2375), protocol: "http" });
}

// Every call that reads or changes a container or volume by name first checks it carries
// hattisar.managed=true and the expected hattisar.box label, and refuses anything else.
export class ManagedDocker implements DockerApi {
  constructor(private readonly docker: Docker) {}

  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  // Internal networks are skipped: hattisar also sits on the internal one it shares with the
  // socket proxy, and a box there could reach the Docker API (a box admin can run shell commands).
  async ownNetwork(): Promise<string> {
    const networks: NetworkSummary[] = (await this.docker.listNetworks())
      .filter((network) => !network.Internal)
      .map((network) => ({
        name: network.Name,
        subnets: (network.IPAM?.Config ?? []).flatMap((config) =>
          config.Subnet ? [config.Subnet] : [],
        ),
      }));
    const name = networkFor(networks, ipv4Addresses());
    if (name === undefined) throw new Error("cannot find the Docker network hattisar runs on");
    return name;
  }

  // Deliberately unfiltered and read-only: a port published by any container is unavailable.
  async publishedPorts(): Promise<number[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.flatMap((container) =>
      container.Ports.flatMap((port) => (port.PublicPort ? [port.PublicPort] : [])),
    );
  }

  async createVolume(name: string, box: string): Promise<void> {
    if ((await this.volumeLabels(name)) !== undefined) {
      throw new Error(`Docker volume ${name} already exists`);
    }
    await this.docker.createVolume({ Name: name, Labels: managedLabels(box) });
  }

  async createContainer(spec: ContainerSpec): Promise<void> {
    await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: managedLabels(spec.box),
      ExposedPorts: { [POSTGRES_PORT]: {} },
      HostConfig: {
        PortBindings: { [POSTGRES_PORT]: [{ HostPort: String(spec.hostPort) }] },
        Mounts: [{ Type: "volume", Source: spec.volume, Target: DATA_DIR }],
        RestartPolicy: { Name: "unless-stopped" },
      },
      NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
    });
  }

  async start(name: string, box: string): Promise<void> {
    const container = await this.requireContainer(name, box);
    if (!container.running) await this.docker.getContainer(container.id).start();
  }

  async stop(name: string, box: string): Promise<void> {
    const container = await this.requireContainer(name, box);
    if (container.running) await this.docker.getContainer(container.id).stop();
  }

  // Already gone counts as removed.
  async removeContainer(name: string, box: string): Promise<void> {
    const container = await this.managedContainer(name, box);
    if (container === undefined) return;
    await this.docker.getContainer(container.id).remove({ force: true });
  }

  async removeVolume(name: string, box: string): Promise<void> {
    const labels = await this.volumeLabels(name);
    if (labels === undefined) return;
    ownLabels("Volume", name, box, labels);
    await this.docker.getVolume(name).remove();
  }

  private async managedContainer(
    name: string,
    box: string,
  ): Promise<{ id: string; running: boolean } | undefined> {
    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.docker.getContainer(name).inspect();
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
    ownLabels("Container", name, box, info.Config.Labels ?? {});
    return { id: info.Id, running: info.State.Running };
  }

  private async requireContainer(name: string, box: string) {
    const container = await this.managedContainer(name, box);
    if (container === undefined) throw new Error(`Container ${name} does not exist`);
    return container;
  }

  private async volumeLabels(name: string): Promise<Record<string, string> | undefined> {
    try {
      return (await this.docker.getVolume(name).inspect()).Labels ?? {};
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }
}
