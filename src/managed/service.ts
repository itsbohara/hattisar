import { randomBytes } from "node:crypto";
import { type BoxConnection, safeErrorMessage } from "../boxes/admin-client.js";
import { checkBox, type E1Result } from "../boxes/e1.js";
import {
  type BoxResult,
  boxConnection,
  boxInUseProblem,
  type RemoveResult,
} from "../boxes/service.js";
import type { BindMount, Config, PortRange } from "../config.js";
import type { PoolerTenants } from "../pooler/tenants.js";
import { type Box, deleteBox, getBoxByName, insertBox, listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { encryptSecret } from "../registry/secrets.js";
import {
  type DockerApi,
  dockerFromHost,
  dockerMessage,
  isPortConflict,
  ManagedDocker,
} from "./docker.js";
import { pickPort } from "./ports.js";
import { waitUntilReady } from "./readiness.js";

export const MANAGED_IMAGE = "supabase/postgres:17.6.1.136";
// The image sets this role's password from POSTGRES_PASSWORD on first boot (migrate.sh).
const ADMIN_USER = "supabase_admin";
const NAME_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;
const PORT_ATTEMPTS = 10;

export function containerNameFor(box: string): string {
  return `hattisar-box-${box}`;
}

export function volumeNameFor(box: string): string {
  return `hattisar_box_${box}`;
}

function containerOf(box: Box): string {
  return box.containerName ?? containerNameFor(box.name);
}

export interface ManagedBoxDeps {
  db: Registry;
  secretKey: Buffer;
  docker: DockerApi;
  publicHost: string;
  portRange: PortRange;
  check: (conn: BoxConnection) => Promise<E1Result>;
  waitReady: (conn: BoxConnection) => Promise<void>;
  pooler: PoolerTenants;
  mounts: BindMount[];
}

class ProblemsError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

interface Created {
  volume: boolean;
  container: boolean;
}

export class ManagedBoxes {
  private creating: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ManagedBoxDeps) {}

  // One create at a time: two concurrent creates would otherwise pick the same free port.
  create(name: string): Promise<BoxResult> {
    const run = this.creating.then(() => this.createNow(name));
    this.creating = run.catch(() => undefined);
    return run;
  }

  async remove(box: Box): Promise<RemoveResult> {
    const problem = boxInUseProblem(this.deps.db, box);
    if (problem !== undefined) return { ok: false, problem };
    await this.deps.pooler.drop(box);
    try {
      await this.deps.docker.removeContainer(containerOf(box), box.name);
      await this.deps.docker.removeVolume(volumeNameFor(box.name), box.name);
    } catch (error) {
      return { ok: false, problem: `Could not remove box ${box.name}: ${dockerMessage(error)}` };
    }
    deleteBox(this.deps.db, box.id);
    return { ok: true };
  }

  async start(box: Box): Promise<void> {
    await this.deps.docker.start(containerOf(box), box.name);
    await this.deps.waitReady(boxConnection(box, this.deps.secretKey));
    await this.deps.pooler.ensure(box);
  }

  async stop(box: Box): Promise<void> {
    await this.deps.docker.stop(containerOf(box), box.name);
  }

  private async createNow(name: string): Promise<BoxResult> {
    const { db, docker } = this.deps;
    if (!NAME_PATTERN.test(name)) {
      return {
        ok: false,
        problems: [
          "Name must be 3-40 characters: lowercase letters, digits and hyphens, starting with a letter",
        ],
      };
    }
    if (getBoxByName(db, name) !== undefined) {
      return { ok: false, problems: [`A box named ${name} already exists`] };
    }
    // Hex: migrate.sh splices the password into SQL inside single quotes.
    const password = randomBytes(24).toString("hex");
    const containerName = containerNameFor(name);
    const conn: BoxConnection = {
      host: containerName,
      port: 5432,
      user: ADMIN_USER,
      password,
      sslmode: "disable",
    };
    const created: Created = { volume: false, container: false };
    try {
      await docker.ensureImage(MANAGED_IMAGE);
      const network = await docker.ownNetwork();
      await docker.createVolume(volumeNameFor(name), name);
      created.volume = true;
      const hostPort = await this.startOnFreePort(name, network, password, created);
      await this.deps.waitReady(conn);
      const e1 = await this.deps.check(conn);
      if (!e1.ok) throw new ProblemsError(e1.problems);
      const box = insertBox(db, {
        name,
        kind: "managed",
        devOnly: false,
        host: containerName,
        port: 5432,
        adminUser: ADMIN_USER,
        adminPasswordEnc: encryptSecret(password, this.deps.secretKey),
        sslmode: "disable",
        publicHost: this.deps.publicHost,
        publicPort: hostPort,
        poolerTenant: null,
        poolerSessionPort: null,
        poolerTransactionPort: null,
        containerName,
      });
      await this.deps.pooler.ensure(box);
      return { ok: true, box };
    } catch (error) {
      const problems =
        error instanceof ProblemsError
          ? error.problems
          : [`Could not start box ${name}: ${safeErrorMessage(dockerMessage(error), password)}`];
      const cleanup = await this.undo(name, created);
      return { ok: false, problems: cleanup === undefined ? problems : [...problems, cleanup] };
    }
  }

  // Docker cannot see ports held by host processes, so a start that loses the port to one is
  // retried on the next free port.
  private async startOnFreePort(
    name: string,
    network: string,
    password: string,
    created: Created,
  ): Promise<number> {
    const { db, docker, portRange } = this.deps;
    const containerName = containerNameFor(name);
    const refused: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const used = [
        ...listBoxes(db).map((box) => box.publicPort),
        ...(await docker.publishedPorts()),
        ...refused,
      ];
      const hostPort = pickPort(portRange, used);
      if (hostPort === undefined) {
        throw new Error(`no free port in ${portRange.start}-${portRange.end}`);
      }
      await docker.createContainer({
        name: containerName,
        box: name,
        image: MANAGED_IMAGE,
        volume: volumeNameFor(name),
        network,
        hostPort,
        env: { POSTGRES_PASSWORD: password },
        mounts: this.deps.mounts.map((mount) => ({
          source: mount.source.replaceAll("{box}", name),
          target: mount.target,
        })),
      });
      created.container = true;
      try {
        await docker.start(containerName, name);
        return hostPort;
      } catch (error) {
        if (!isPortConflict(error) || attempt >= PORT_ATTEMPTS) throw error;
        refused.push(hostPort);
        await docker.removeContainer(containerName, name);
        created.container = false;
      }
    }
  }

  // Only what this attempt created: a same-named container or volume may belong to someone else.
  private async undo(name: string, created: Created): Promise<string | undefined> {
    try {
      if (created.container) await this.deps.docker.removeContainer(containerNameFor(name), name);
      if (created.volume) await this.deps.docker.removeVolume(volumeNameFor(name), name);
      return undefined;
    } catch (error) {
      return `Cleanup failed (${dockerMessage(error)}): container ${containerNameFor(name)} or volume ${volumeNameFor(name)} may remain`;
    }
  }
}

// No Docker client exists unless managed boxes are on.
export function createManagedBoxes(
  config: Config,
  db: Registry,
  secretKey: Buffer,
  pooler: PoolerTenants,
) {
  if (!config.managedBoxes) return undefined;
  return new ManagedBoxes({
    db,
    secretKey,
    docker: new ManagedDocker(dockerFromHost(config.dockerHost)),
    publicHost: config.publicHost,
    portRange: config.managedPortRange,
    check: checkBox,
    waitReady: (conn) => waitUntilReady(conn),
    pooler,
    mounts: config.managedBoxMounts,
  });
}
