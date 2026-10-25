import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { BoxConnection } from "../../src/boxes/admin-client.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import type { ContainerSpec, DockerApi } from "../../src/managed/docker.js";
import { managedLifecycle } from "../../src/managed/lifecycle.js";
import { createManagedBoxes, ManagedBoxes } from "../../src/managed/service.js";
import { type Box, getBoxByName, listBoxes } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import {
  getProjectByRef,
  insertProject,
  markProjectDeleted,
  type Project,
} from "../../src/registry/projects.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { RecordingPooler } from "../helpers/pooler.js";
import { signInToRegistry } from "../helpers/session.js";

const secretKey = deriveSecretKey("m".repeat(32));
const env = {
  HATTISAR_SECRET_KEY: "m".repeat(32),
  PG_META_CRYPTO_KEY: "unit",
  POSTGRES_PASSWORD: "shared-password",
  POOLER_TENANT_ID: "hattisar",
  POOLER_JWT_SECRET: "pooler-jwt-secret",
  HATTISAR_PUBLIC_HOST: "db.example.test",
};

class FakeDocker implements DockerApi {
  calls: string[] = [];
  published: number[] = [];
  portsHeldByHost = new Set<number>();
  containers = new Map<string, { spec: ContainerSpec; running: boolean }>();
  volumes = new Set<string>();

  async ensureImage(image: string) {
    this.calls.push(`ensureImage ${image}`);
  }
  async ownNetwork() {
    return "hattisar_default";
  }
  async publishedPorts() {
    return this.published;
  }
  async createVolume(name: string) {
    this.calls.push(`createVolume ${name}`);
    this.volumes.add(name);
  }
  async createContainer(spec: ContainerSpec) {
    this.calls.push(`createContainer ${spec.name} ${spec.hostPort}`);
    this.containers.set(spec.name, { spec, running: false });
  }
  isRunning(name: string) {
    return this.containers.get(name)?.running ?? false;
  }
  async start(name: string) {
    this.calls.push(`start ${name}`);
    const container = this.containers.get(name);
    if (!container) throw new Error(`no ${name}`);
    if (this.portsHeldByHost.has(container.spec.hostPort)) {
      throw new Error("Bind for 0.0.0.0:55000 failed: port is already allocated");
    }
    container.running = true;
  }
  async stop(name: string) {
    this.calls.push(`stop ${name}`);
    const container = this.containers.get(name);
    if (container) container.running = false;
  }
  async removeContainer(name: string) {
    this.calls.push(`removeContainer ${name}`);
    this.containers.delete(name);
  }
  async removeVolume(name: string) {
    this.calls.push(`removeVolume ${name}`);
    this.volumes.delete(name);
  }
}

let dataDir: string;
let db: Registry;
let docker: FakeDocker;
let checked: BoxConnection[];
let e1Problems: string[];
let pooler: RecordingPooler;
let managed: ManagedBoxes;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-managed-"));
  db = openRegistry(dataDir);
  seedSharedBox(db, loadConfig(env), secretKey);
  docker = new FakeDocker();
  checked = [];
  e1Problems = [];
  pooler = new RecordingPooler(db);
  managed = new ManagedBoxes({
    db,
    secretKey,
    pooler,
    docker,
    publicHost: "db.example.test",
    portRange: { start: 55000, end: 55009 },
    check: async (conn) => {
      checked.push(conn);
      return { ok: e1Problems.length === 0, problems: e1Problems };
    },
    waitReady: async () => {},
  });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedProject(box: Box, ref: string): Project {
  const dbName = ref.replaceAll("-", "_");
  return insertProject(db, {
    ref,
    name: ref,
    boxId: box.id,
    dbName,
    ownerRole: `hs_${dbName}_owner`,
    ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
  });
}

describe("creating a managed box", () => {
  it("starts a labelled container on the first free port and registers it", async () => {
    docker.published = [55000];
    const result = await managed.create("prod-eu");
    expect(result.ok).toBe(true);
    const box = getBoxByName(db, "prod-eu") as Box;
    expect(box).toMatchObject({
      kind: "managed",
      devOnly: false,
      host: "hattisar-box-prod-eu",
      port: 5432,
      adminUser: "supabase_admin",
      sslmode: "disable",
      publicHost: "db.example.test",
      publicPort: 55001,
      containerName: "hattisar-box-prod-eu",
    });
    expect(pooler.calls).toEqual([{ action: "ensure", box, rowExists: true }]);
    const container = docker.containers.get("hattisar-box-prod-eu");
    expect(container?.spec).toMatchObject({
      box: "prod-eu",
      image: "supabase/postgres:17.6.1.136",
      volume: "hattisar_box_prod-eu",
      network: "hattisar_default",
    });
    const password = decryptSecret(box.adminPasswordEnc, secretKey);
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(container?.spec.env).toEqual({ POSTGRES_PASSWORD: password });
    expect(checked).toEqual([
      {
        host: "hattisar-box-prod-eu",
        port: 5432,
        user: "supabase_admin",
        password,
        sslmode: "disable",
      },
    ]);
  });

  it("skips ports registered boxes already use", async () => {
    await managed.create("first-box");
    await managed.create("second-box");
    expect(getBoxByName(db, "second-box")?.publicPort).toBe(55001);
  });

  it("moves to the next port when a host process holds the picked one", async () => {
    docker.portsHeldByHost.add(55000);
    const result = await managed.create("prod-eu");
    expect(result.ok).toBe(true);
    expect(getBoxByName(db, "prod-eu")?.publicPort).toBe(55001);
    expect(docker.calls).toContain("removeContainer hattisar-box-prod-eu");
  });

  it("refuses an invalid or taken name without touching Docker", async () => {
    expect(await managed.create("Bad Name")).toMatchObject({ ok: false });
    expect(await managed.create("shared")).toEqual({
      ok: false,
      problems: ["A box named shared already exists"],
    });
    expect(docker.calls).toEqual([]);
  });

  it("removes what it created and registers nothing when E1 fails", async () => {
    e1Problems = ["Extension not available: pg_stat_statements"];
    const result = await managed.create("prod-eu");
    expect(result).toEqual({
      ok: false,
      problems: ["Extension not available: pg_stat_statements"],
    });
    expect(getBoxByName(db, "prod-eu")).toBeUndefined();
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(pooler.calls).toEqual([]);
  });

  it("leaves a same-named container alone when creating its own fails", async () => {
    docker.createContainer = async () => {
      throw new Error("Conflict. The container name is already in use");
    };
    const result = await managed.create("prod-eu");
    expect(result).toEqual({
      ok: false,
      problems: ["Could not start box prod-eu: Conflict. The container name is already in use"],
    });
    expect(docker.calls).not.toContain("removeContainer hattisar-box-prod-eu");
    expect(docker.calls).toContain("removeVolume hattisar_box_prod-eu");
  });

  it("reports when the range is full", async () => {
    docker.published = Array.from({ length: 10 }, (_, i) => 55000 + i);
    const result = await managed.create("prod-eu");
    expect(result).toEqual({
      ok: false,
      problems: ["Could not start box prod-eu: no free port in 55000-55009"],
    });
  });
});

describe("removing a managed box", () => {
  it("drops the pooler tenant, removes the container and volume, then the row", async () => {
    await managed.create("prod-eu");
    const box = getBoxByName(db, "prod-eu") as Box;
    pooler.calls = [];
    const removeContainer = docker.removeContainer.bind(docker);
    docker.removeContainer = async (name: string) => {
      docker.calls.push(`pooler calls: ${pooler.calls.map((call) => call.action).join(",")}`);
      await removeContainer(name);
    };
    expect(await managed.remove(box)).toEqual({ ok: true });
    expect(pooler.calls).toEqual([{ action: "drop", box, rowExists: true }]);
    expect(docker.calls).toContain("pooler calls: drop");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(getBoxByName(db, "prod-eu")).toBeUndefined();
  });

  it("refuses while projects remain and keeps the container", async () => {
    await managed.create("prod-eu");
    const box = getBoxByName(db, "prod-eu") as Box;
    seedProject(box, "my-app");
    pooler.calls = [];
    const result = await managed.remove(box);
    expect(result.ok).toBe(false);
    expect(docker.containers.size).toBe(1);
    expect(pooler.calls).toEqual([]);
  });

  it("keeps the row when Docker refuses", async () => {
    await managed.create("prod-eu");
    const box = getBoxByName(db, "prod-eu") as Box;
    docker.removeContainer = async () => {
      throw new Error("Container hattisar-box-prod-eu is not labelled hattisar.managed=true");
    };
    const result = await managed.remove(box);
    expect(result).toEqual({
      ok: false,
      problem:
        "Could not remove box prod-eu: Container hattisar-box-prod-eu is not labelled hattisar.managed=true",
    });
    expect(getBoxByName(db, "prod-eu")).toBeDefined();
  });
});

it("ensures the pooler tenant after starting a managed box", async () => {
  await managed.create("prod-eu");
  const box = getBoxByName(db, "prod-eu") as Box;
  await managed.stop(box);
  pooler.calls = [];
  docker.calls = [];
  await managed.start(box);
  expect(docker.calls).toContain("start hattisar-box-prod-eu");
  expect(pooler.calls).toEqual([{ action: "ensure", box, rowExists: true }]);
});

describe("managed lifecycle hook", () => {
  let box: Box;
  let hook: ReturnType<typeof managedLifecycle>;

  beforeEach(async () => {
    await managed.create("prod-eu");
    box = getBoxByName(db, "prod-eu") as Box;
    hook = managedLifecycle(db, managed);
    docker.calls = [];
  });

  function softDelete(project: Project): Project {
    markProjectDeleted(db, project.id, `${project.dbName}__deleted_20261020`);
    return getProjectByRef(db, project.ref) as Project;
  }

  it("stops the box when its only project is deleted and starts it on restore", async () => {
    const project = softDelete(seedProject(box, "my-app"));
    await hook(box, project, "deleted");
    expect(await docker.isRunning("hattisar-box-prod-eu")).toBe(false);
    await hook(box, project, "restoring");
    expect(await docker.isRunning("hattisar-box-prod-eu")).toBe(true);
  });

  it("keeps the box running while another project is active", async () => {
    seedProject(box, "other-app");
    const project = softDelete(seedProject(box, "my-app"));
    await hook(box, project, "deleted");
    expect(docker.calls).toEqual([]);
  });

  it("skips the SQL for the box's last project and removes the box once it is purged", async () => {
    const project = softDelete(seedProject(box, "my-app"));
    expect(await hook(box, project, "purging")).toBe("skip-sql");
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    await hook(box, project, "purged");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(getBoxByName(db, "prod-eu")).toBeUndefined();
    expect(pooler.calls.at(-1)).toMatchObject({ action: "drop", box: { id: box.id } });
  });

  it("starts a stopped box to purge one of several deleted projects, then stops it again", async () => {
    softDelete(seedProject(box, "other-app"));
    const project = softDelete(seedProject(box, "my-app"));
    await docker.stop("hattisar-box-prod-eu");
    expect(await hook(box, project, "purging")).toBeUndefined();
    expect(await docker.isRunning("hattisar-box-prod-eu")).toBe(true);
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    await hook(box, project, "purged");
    expect(await docker.isRunning("hattisar-box-prod-eu")).toBe(false);
    expect(getBoxByName(db, "prod-eu")).toBeDefined();
  });

  it("ignores other kinds of box", async () => {
    const shared = listBoxes(db).find((b) => b.kind === "shared") as Box;
    const project = softDelete(seedProject(shared, "my-app"));
    expect(await hook(shared, project, "purging")).toBeUndefined();
    expect(docker.calls).toEqual([]);
  });
});

describe("with managed boxes off", () => {
  it("builds no Docker client", () => {
    expect(createManagedBoxes(loadConfig(env), db, secretKey, pooler)).toBeUndefined();
  });

  it("serves no managed-box pages or options", async () => {
    const app = createApp(loadConfig(env), db, undefined, pooler);
    const cookie = signInToRegistry(db);
    const get = (path: string) => app.request(path, { headers: { cookie } });
    expect((await get("/_hs/managed-boxes/new")).status).toBe(404);
    const post = await app.request("/_hs/managed-boxes", {
      method: "POST",
      headers: { cookie, origin: "http://localhost" },
      body: new URLSearchParams({ name: "prod-eu" }),
    });
    expect(post.status).toBe(404);
    expect(await (await get("/_hs/boxes")).text()).not.toContain("New managed box");
    expect(await (await get("/_hs/projects/new")).text()).not.toContain("New dedicated box");
  });

  it("offers them when on", async () => {
    const app = createApp(loadConfig(env), db, managed, pooler);
    const cookie = signInToRegistry(db);
    const get = (path: string) => app.request(path, { headers: { cookie } });
    expect((await get("/_hs/managed-boxes/new")).status).toBe(200);
    expect(await (await get("/_hs/boxes")).text()).toContain("New managed box");
    expect(await (await get("/_hs/projects/new")).text()).toContain("New dedicated box");
  });
});
