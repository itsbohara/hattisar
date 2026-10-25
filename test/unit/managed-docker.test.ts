import type Docker from "dockerode";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ContainerSpec,
  ManagedDocker,
  UnmanagedObjectError,
} from "../../src/managed/docker.js";

const BOX = "alpha";
const NAME = "hattisar-box-alpha";

let labels: Record<string, string> | undefined;
let running: boolean;
let changes: string[];
let created: unknown[];

function stubDocker(): Docker {
  return {
    createContainer: async (body: unknown) => created.push(body),
    getContainer: (id: string) => ({
      inspect: async () => ({
        Id: `id-of-${id}`,
        Config: { Labels: labels },
        State: { Running: running },
      }),
      start: async () => changes.push(`start ${id}`),
      stop: async () => changes.push(`stop ${id}`),
      remove: async () => changes.push(`remove container ${id}`),
    }),
    getVolume: (name: string) => ({
      inspect: async () => ({ Name: name, Labels: labels }),
      remove: async () => changes.push(`remove volume ${name}`),
    }),
  } as unknown as Docker;
}

const operations: [string, (docker: ManagedDocker) => Promise<void>][] = [
  ["start", (docker) => docker.start(NAME, BOX)],
  ["stop", (docker) => docker.stop(NAME, BOX)],
  ["remove a container", (docker) => docker.removeContainer(NAME, BOX)],
  ["remove a volume", (docker) => docker.removeVolume(NAME, BOX)],
];

beforeEach(() => {
  changes = [];
  created = [];
});

describe("ManagedDocker refuses objects hattisar does not own", () => {
  const foreign: [string, Record<string, string> | undefined][] = [
    ["no labels", undefined],
    ["no managed label", { "hattisar.box": BOX }],
    ["managed=false", { "hattisar.managed": "false", "hattisar.box": BOX }],
    ["another box's label", { "hattisar.managed": "true", "hattisar.box": "beta" }],
    ["no box label", { "hattisar.managed": "true" }],
  ];

  describe.each(foreign)("labelled with %s", (_, objectLabels) => {
    it.each(operations)("will not %s", async (_op, run) => {
      labels = objectLabels;
      running = true;
      await expect(run(new ManagedDocker(stubDocker()))).rejects.toThrow(UnmanagedObjectError);
      expect(changes).toEqual([]);
    });
  });
});

describe("ManagedDocker acts on its own objects", () => {
  beforeEach(() => {
    labels = { "hattisar.managed": "true", "hattisar.box": BOX };
  });

  it("starts a stopped container and stops a running one", async () => {
    running = false;
    await new ManagedDocker(stubDocker()).start(NAME, BOX);
    running = true;
    await new ManagedDocker(stubDocker()).stop(NAME, BOX);
    expect(changes).toEqual([`start id-of-${NAME}`, `stop id-of-${NAME}`]);
  });

  it("removes the container and the volume", async () => {
    running = true;
    const docker = new ManagedDocker(stubDocker());
    await docker.removeContainer(NAME, BOX);
    await docker.removeVolume(NAME, BOX);
    expect(changes).toEqual([`remove container id-of-${NAME}`, `remove volume ${NAME}`]);
  });
});

describe("ManagedDocker.createContainer", () => {
  const spec: ContainerSpec = {
    name: NAME,
    box: BOX,
    image: "supabase/postgres:17.6.1.136",
    volume: "hattisar_box_alpha",
    network: "hattisar_default",
    hostPort: 55000,
    env: { POSTGRES_PASSWORD: "pw" },
    mounts: [],
  };
  const dataVolume = {
    Type: "volume",
    Source: "hattisar_box_alpha",
    Target: "/var/lib/postgresql/data",
  };

  it("creates a labelled container with only the data volume when no mounts are set", async () => {
    await new ManagedDocker(stubDocker()).createContainer(spec);
    expect(created).toEqual([
      {
        name: NAME,
        Image: "supabase/postgres:17.6.1.136",
        Env: ["POSTGRES_PASSWORD=pw"],
        Labels: { "hattisar.managed": "true", "hattisar.box": BOX },
        ExposedPorts: { "5432/tcp": {} },
        HostConfig: {
          PortBindings: { "5432/tcp": [{ HostPort: "55000" }] },
          Mounts: [dataVolume],
          RestartPolicy: { Name: "unless-stopped" },
        },
        NetworkingConfig: { EndpointsConfig: { hattisar_default: {} } },
      },
    ]);
  });

  it("adds the operator's mounts read-only after the data volume", async () => {
    await new ManagedDocker(stubDocker()).createContainer({
      ...spec,
      mounts: [
        { source: "/opt/wal-g", target: "/usr/local/bin/wal-g" },
        { source: "/opt/w/alpha.yaml", target: "/etc/wal-g/walg.yaml" },
      ],
    });
    expect(created).toMatchObject([
      {
        HostConfig: {
          Mounts: [
            dataVolume,
            { Type: "bind", Source: "/opt/wal-g", Target: "/usr/local/bin/wal-g", ReadOnly: true },
            {
              Type: "bind",
              Source: "/opt/w/alpha.yaml",
              Target: "/etc/wal-g/walg.yaml",
              ReadOnly: true,
            },
          ],
        },
      },
    ]);
  });
});
