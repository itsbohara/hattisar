import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "../../src/auth/middleware.js";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import {
  purgeExpiredProjects,
  purgeProject,
  restoreProject,
  softDeleteProject,
} from "../../src/projects/lifecycle.js";
import { projectRoutes } from "../../src/projects/routes.js";
import type { LifecycleEvent, ProjectServiceDeps } from "../../src/projects/service.js";
import { trashRoutes } from "../../src/projects/trash-routes.js";
import { type Box, getSharedBox, insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import {
  getProjectByRef,
  insertProject,
  markProjectDeleted,
  type Project,
} from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { insertUser } from "../../src/registry/users.js";

const secretKey = deriveSecretKey("p".repeat(32));
const ADMIN_PASSWORD = "box-admin-secret";
const PURGE_AFTER_DAYS = 7;

let dataDir: string;
let db: Registry;
let box: Box;
let sql: string[];
let failOn: RegExp | undefined;
let renamesInUse: number;
let takenNames: string[];
let foreignPlaces: string[];
let events: { ref: string; event: LifecycleEvent }[];
let deps: ProjectServiceDeps;
let app: Hono<AuthEnv>;

const fakeAdmin: AdminClientRunner = async (_conn, run) => {
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (failOn?.test(text)) throw new Error(`boom (${ADMIN_PASSWORD})`);
      if (text.includes(" RENAME TO ") && renamesInUse > 0) {
        renamesInUse -= 1;
        throw Object.assign(new Error("database is being accessed by other users"), {
          code: "55006",
        });
      }
      if (text.startsWith("select datname from pg_database")) {
        return { rowCount: takenNames.length, rows: takenNames.map((datname) => ({ datname })) };
      }
      if (text.includes("pg_shdepend")) {
        return { rowCount: foreignPlaces.length, rows: foreignPlaces.map((place) => ({ place })) };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return run(client as unknown as pg.Client);
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-lifecycle-"));
  db = openRegistry(dataDir);
  seedSharedBox(
    db,
    loadConfig({
      HATTISAR_SECRET_KEY: "p".repeat(32),
      PG_META_CRYPTO_KEY: "unit",
      POSTGRES_PASSWORD: ADMIN_PASSWORD,
      POOLER_TENANT_ID: "hattisar",
    }),
    secretKey,
  );
  box = getSharedBox(db) as Box;
  sql = [];
  failOn = undefined;
  renamesInUse = 0;
  takenNames = [];
  foreignPlaces = [];
  events = [];
  deps = {
    db,
    secretKey,
    admin: fakeAdmin,
    refreshPooler: async () => {},
    onLifecycle: async (_box, project, event) => {
      events.push({ ref: project.ref, event });
    },
  };
  const user = insertUser(db, { username: "admin", passwordHash: "unused" });
  app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set("session", { user, tokenHash: "unused" });
    await next();
  });
  app.route("/", projectRoutes({ ...deps, backupHourUtc: 2 }));
  app.route("/", trashRoutes({ ...deps, purgeAfterDays: PURGE_AFTER_DAYS }));
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(ref = "my-app"): Project {
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

function project(ref = "my-app"): Project | undefined {
  return getProjectByRef(db, ref);
}

function post(path: string, fields: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "POST", body: new URLSearchParams(fields) }));
}

function renameAttempt(): unknown[] {
  return [
    expect.stringMatching(/^select pg_terminate_backend\(pid\) from pg_stat_activity/),
    "select datname from pg_database where starts_with(datname, $1)",
    expect.stringMatching(/^ALTER DATABASE "my_app" RENAME TO "my_app__deleted_\d{8}"$/),
  ];
}

async function softDeleted(ref: string, at: Date): Promise<Project> {
  const result = await softDeleteProject(deps, project(ref) as Project, box, at);
  expect(result).toEqual({ ok: true });
  return project(ref) as Project;
}

describe("deleting a project", () => {
  it("refuses unless the ref is typed, without touching the box", async () => {
    seed();
    const response = await post("/_hs/projects/my-app/delete", { confirm: "my-ap" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Type the ref my-app to confirm");
    expect(sql).toEqual([]);
    expect(project()?.status).toBe("active");
  });

  it("commits the revoke before terminating and renaming, leaving the role able to log in", async () => {
    seed();
    const response = await post("/_hs/projects/my-app/delete", { confirm: "my-app" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/trash");
    expect(sql).toEqual([
      'REVOKE CONNECT ON DATABASE "my_app" FROM "hs_my_app_owner"',
      ...renameAttempt(),
    ]);
    expect(project()).toMatchObject({ status: "deleted", deletedAt: expect.any(String) });
    expect(events).toEqual([{ ref: "my-app", event: "deleted" }]);
    expect((await app.request("/_hs/projects/my-app")).status).toBe(404);
  });

  it("names the renamed database by date and skips names already taken", async () => {
    seed();
    takenNames = ["my_app__deleted_20261020"];
    const deleted = await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    expect(deleted.deletedDbName).toBe("my_app__deleted_20261020_2");
    expect(deleted.deletedAt).toBe("2026-10-20T08:00:00.000Z");
    expect(sql).toContain('ALTER DATABASE "my_app" RENAME TO "my_app__deleted_20261020_2"');
  });

  it("grants CONNECT back and keeps the project active when the rename fails", async () => {
    seed();
    failOn = /RENAME/;
    const response = await post("/_hs/projects/my-app/delete", { confirm: "my-app" });
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain("Could not delete the project: boom");
    expect(html).not.toContain(ADMIN_PASSWORD);
    expect(sql.at(-1)).toBe('GRANT CONNECT ON DATABASE "my_app" TO "hs_my_app_owner"');
    expect(project()?.status).toBe("active");
    expect(events).toEqual([]);
  });

  it("terminates again and retries a rename that finds the database in use", async () => {
    seed();
    renamesInUse = 2;
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    expect(sql).toEqual([
      'REVOKE CONNECT ON DATABASE "my_app" FROM "hs_my_app_owner"',
      ...renameAttempt(),
      ...renameAttempt(),
      ...renameAttempt(),
    ]);
  });

  it("gives up after three in-use renames and grants CONNECT back", async () => {
    seed();
    renamesInUse = 3;
    const result = await softDeleteProject(deps, project() as Project, box);
    expect(result).toEqual({
      ok: false,
      problem: "Could not delete the project: database is being accessed by other users",
    });
    expect(sql.filter((text) => text.includes(" RENAME TO "))).toHaveLength(3);
    expect(sql.at(-1)).toBe('GRANT CONNECT ON DATABASE "my_app" TO "hs_my_app_owner"');
    expect(project()?.status).toBe("active");
  });

  it("says so when CONNECT cannot be granted back either", async () => {
    seed();
    renamesInUse = 3;
    failOn = /^GRANT/;
    const result = await softDeleteProject(deps, project() as Project, box);
    expect(result.ok).toBe(false);
    const { problem } = result as { problem: string };
    expect(problem).toContain("granting CONNECT back to hs_my_app_owner also failed");
    expect(problem).not.toContain(ADMIN_PASSWORD);
    expect(project()?.status).toBe("active");
  });
});

describe("the Trash page", () => {
  it("lists deleted projects with their deletion and purge dates", async () => {
    seed("my-app");
    seed("kept");
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    const html = await (await app.request("/_hs/trash")).text();
    expect(html).toContain('data-project="my-app"');
    expect(html).not.toContain('data-project="kept"');
    expect(html).toContain("2026-10-20 08:00 UTC");
    expect(html).toContain("2026-10-27 08:00 UTC");
    expect(html).toContain('action="/_hs/trash/my-app/restore"');
    expect(html).toContain('action="/_hs/trash/my-app/purge"');
  });

  it("says so when empty", async () => {
    expect(await (await app.request("/_hs/trash")).text()).toContain("Trash is empty.");
  });

  it("answers restore and purge of an active or unknown project with 404", async () => {
    seed();
    expect((await post("/_hs/trash/my-app/restore")).status).toBe(404);
    expect((await post("/_hs/trash/nope/purge", { confirm: "nope" })).status).toBe(404);
    expect(sql).toEqual([]);
  });
});

describe("restoring a project", () => {
  it("reverses every step and shows the project again", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    sql = [];
    const response = await post("/_hs/trash/my-app/restore");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/projects/my-app");
    expect(sql).toEqual([
      "BEGIN",
      'ALTER DATABASE "my_app__deleted_20261020" RENAME TO "my_app"',
      'GRANT CONNECT ON DATABASE "my_app" TO "hs_my_app_owner"',
      "COMMIT",
    ]);
    expect(project()).toMatchObject({ status: "active", deletedAt: null, deletedDbName: null });
    expect(events.map((e) => e.event)).toEqual(["deleted", "restoring"]);
  });

  it("keeps the project in Trash when the box refuses", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    failOn = /RENAME/;
    const response = await post("/_hs/trash/my-app/restore");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Could not restore the project: boom");
    expect(project()?.status).toBe("deleted");
  });
});

describe("purging a project", () => {
  it("refuses unless the ref is typed", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    sql = [];
    const response = await post("/_hs/trash/my-app/purge", { confirm: "" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Type the ref my-app to confirm purging it.");
    expect(sql).toEqual([]);
  });

  it("drops the renamed database and the role, then the row", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    sql = [];
    const response = await post("/_hs/trash/my-app/purge", { confirm: "my-app" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/trash");
    expect(sql.slice(1)).toEqual([
      'DROP DATABASE IF EXISTS "my_app__deleted_20261020" WITH (FORCE)',
      'DROP ROLE IF EXISTS "hs_my_app_owner"',
    ]);
    expect(project()).toBeUndefined();
    expect(events.map((e) => e.event)).toEqual(["deleted", "purged"]);
  });

  it("drops nothing and keeps the row when the role has objects elsewhere", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    foreignPlaces = ["postgres"];
    sql = [];
    const response = await post("/_hs/trash/my-app/purge", { confirm: "my-app" });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain(
      "role hs_my_app_owner still owns objects or holds privileges in postgres; nothing was dropped",
    );
    expect(sql.filter((text) => text.startsWith("DROP"))).toEqual([]);
    expect(project()?.status).toBe("deleted");
  });

  it("keeps the row when DROP ROLE fails, so purge can be retried", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-20T08:00:00.000Z"));
    failOn = /^DROP ROLE/;
    const response = await post("/_hs/trash/my-app/purge", { confirm: "my-app" });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Could not purge the project: boom");
    expect(project()?.status).toBe("deleted");
  });
});

describe("purgeExpiredProjects", () => {
  it(`purges only projects deleted more than ${PURGE_AFTER_DAYS} days before the clock`, async () => {
    seed("old-one");
    seed("recent");
    seed("live");
    await softDeleted("old-one", new Date("2026-10-01T00:00:00.000Z"));
    await softDeleted("recent", new Date("2026-10-14T00:00:00.000Z"));

    await purgeExpiredProjects(deps, PURGE_AFTER_DAYS, new Date("2026-10-20T00:00:00.000Z"));
    expect(project("old-one")).toBeUndefined();
    expect(project("recent")?.status).toBe("deleted");
    expect(project("live")?.status).toBe("active");

    await purgeExpiredProjects(deps, PURGE_AFTER_DAYS, new Date("2026-10-21T00:00:01.000Z"));
    expect(project("recent")).toBeUndefined();
    expect(project("live")?.status).toBe("active");
  });

  it("honours a different retention", async () => {
    seed();
    await softDeleted("my-app", new Date("2026-10-19T00:00:00.000Z"));
    await purgeExpiredProjects(deps, 30, new Date("2026-10-20T00:00:00.000Z"));
    expect(project()?.status).toBe("deleted");
    await purgeExpiredProjects(deps, 0, new Date("2026-10-20T00:00:00.000Z"));
    expect(project()).toBeUndefined();
  });
});

describe("a box whose admin password cannot be decrypted", () => {
  function unreadableBox(): Box {
    return insertBox(db, {
      name: "broken",
      kind: "registered",
      devOnly: false,
      host: "pg.internal",
      port: 5432,
      adminUser: "postgres",
      adminPasswordEnc: encryptSecret("x", deriveSecretKey("q".repeat(32))),
      sslmode: "require",
      publicHost: "pg.example.test",
      publicPort: 5432,
      poolerTenant: null,
      poolerSessionPort: null,
      poolerTransactionPort: null,
      containerName: null,
    });
  }

  it("turns delete, restore and purge into inline problems instead of throwing", async () => {
    const broken = unreadableBox();
    const target = seed();
    expect((await softDeleteProject(deps, target, broken)).ok).toBe(false);
    markProjectDeleted(db, target.id, "my_app__deleted_20261020");
    const deleted = project() as Project;
    expect(await restoreProject(deps, deleted, broken)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/^Could not restore the project: /),
    });
    expect(await purgeProject(deps, deleted, broken)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/^Could not purge the project: /),
    });
    expect(sql).toEqual([]);
  });

  it("does not stop the hourly purge of other projects", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
    const broken = unreadableBox();
    const stuck = insertProject(db, {
      ref: "stuck",
      name: "stuck",
      boxId: broken.id,
      dbName: "stuck",
      ownerRole: "hs_stuck_owner",
      ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
    });
    markProjectDeleted(db, stuck.id, "stuck__deleted_20261001", "2026-10-01T00:00:00.000Z");
    seed();
    await softDeleted("my-app", new Date("2026-10-02T00:00:00.000Z"));

    await purgeExpiredProjects(deps, PURGE_AFTER_DAYS, new Date("2026-10-20T00:00:00.000Z"));
    expect(project("stuck")?.status).toBe("deleted");
    expect(project("my-app")).toBeUndefined();
    expect(errors).toEqual([expect.stringMatching(/^hattisar: auto-purge of stuck failed: /)]);
    vi.restoreAllMocks();
  });
});
