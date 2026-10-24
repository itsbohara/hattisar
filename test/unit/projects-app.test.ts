import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "../../src/auth/middleware.js";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { getSharedBox, insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import {
  getProjectByRef,
  markProjectDeleted,
  setProjectOwnerPassword,
} from "../../src/registry/projects.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { insertUser } from "../../src/registry/users.js";

const secretKey = deriveSecretKey("p".repeat(32));
const ADMIN_PASSWORD = "box-admin-secret";

interface Statement {
  database: string;
  sql: string;
}

let dataDir: string;
let db: Registry;
let statements: Statement[];
let failOn: RegExp | undefined;
let databaseExists: boolean;
let databaseSizes: [string, string][];
let refreshed: { ref: string; password: string }[];
let app: Hono<AuthEnv>;

const fakeAdmin: AdminClientRunner = async (_conn, run, database = "postgres") => {
  const client = {
    query: async (sql: string) => {
      statements.push({ database, sql });
      if (failOn?.test(sql)) throw new Error(`boom (${ADMIN_PASSWORD})`);
      if (sql.includes("pg_database_size")) {
        return { rows: databaseSizes.map(([datname, bytes]) => ({ datname, bytes })) };
      }
      const exists = sql.startsWith("select 1 from pg_database") && databaseExists;
      return { rowCount: exists ? 1 : 0, rows: [] };
    },
  };
  return run(client as unknown as pg.Client);
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-projects-"));
  db = openRegistry(dataDir);
  seedSharedBox(
    db,
    loadConfig({
      HATTISAR_SECRET_KEY: "p".repeat(32),
      PG_META_CRYPTO_KEY: "unit",
      POSTGRES_PASSWORD: ADMIN_PASSWORD,
      POOLER_TENANT_ID: "hattisar",
      POOLER_JWT_SECRET: "pooler-jwt-secret",
      HATTISAR_PUBLIC_HOST: "db.example.test",
    }),
    secretKey,
  );
  statements = [];
  failOn = undefined;
  databaseExists = false;
  databaseSizes = [];
  refreshed = [];
  const user = insertUser(db, { username: "admin", passwordHash: "unused" });
  app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set("session", { user, tokenHash: "unused" });
    await next();
  });
  app.route(
    "/",
    projectRoutes({
      db,
      secretKey,
      admin: fakeAdmin,
      refreshPooler: async (_box, project, password) => {
        refreshed.push({ ref: project.ref, password });
      },
      poolerHost: "db.example.test",
      backupHourUtc: 2,
    }),
  );
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function post(path: string, fields: Record<string, string>): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "POST", body: new URLSearchParams(fields) }));
}

function sharedBoxId(): string {
  return String(getSharedBox(db)?.id);
}

function create(ref = "my-app", name = "My App"): Promise<Response> {
  return post("/_hs/projects", { name, ref, boxId: sharedBoxId() });
}

function ownerPassword(ref: string): string {
  return decryptSecret(getProjectByRef(db, ref)?.ownerPasswordEnc ?? "", secretKey);
}

describe("creating a project", () => {
  it("creates role, database and baseline, then stores the row and redirects", async () => {
    const response = await create();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/projects/my-app");

    const sql = statements.map((s) => s.sql);
    expect(sql[0]).toBe("select 1 from pg_database where datname = $1");
    expect(sql[1]).toMatch(
      /^CREATE ROLE "hs_my_app_owner" LOGIN PASSWORD 'SCRAM-SHA-256\$4096:[^']+'$/,
    );
    expect(sql.slice(2, 5)).toEqual([
      'CREATE DATABASE "my_app" OWNER "hs_my_app_owner"',
      'REVOKE CONNECT, TEMPORARY ON DATABASE "my_app" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "my_app" TO "hs_my_app_owner"',
    ]);
    const baseline = statements[5];
    expect(baseline?.database).toBe("my_app");
    expect(baseline?.sql).toContain('ALTER SCHEMA public OWNER TO "hs_my_app_owner";');
    expect(baseline?.sql).toContain(
      'ALTER DATABASE "my_app" SET search_path = "$user", public, extensions;',
    );

    const project = getProjectByRef(db, "my-app");
    expect(project).toMatchObject({
      name: "My App",
      dbName: "my_app",
      ownerRole: "hs_my_app_owner",
      status: "active",
    });
    const password = ownerPassword("my-app");
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statements.some((s) => s.sql.includes(password))).toBe(false);
    expect(refreshed).toEqual([{ ref: "my-app", password }]);
  });

  it.each([
    ["an invalid ref", "My_App", "Ref must be 3-40 characters"],
    ["a reserved ref", "new", 'Ref "new" is reserved'],
  ])("rejects %s without touching the box", async (_label, ref, problem) => {
    const response = await create(ref);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(problem.replaceAll('"', "&quot;"));
    expect(statements).toEqual([]);
  });

  it("rejects a ref already in the registry, deleted projects included", async () => {
    await create();
    markProjectDeleted(db, getProjectByRef(db, "my-app")?.id ?? 0, "my_app__deleted_20261020");
    statements = [];
    const response = await create("my-app", "Again");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Ref my-app is already taken");
    expect(statements).toEqual([]);
  });

  it("rejects a ref whose database already exists on the box", async () => {
    databaseExists = true;
    const response = await create();
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("A database named my_app already exists on box shared");
    expect(statements.map((s) => s.sql)).toEqual(["select 1 from pg_database where datname = $1"]);
    expect(getProjectByRef(db, "my-app")).toBeUndefined();
  });

  it.each([
    ["CREATE ROLE", /^CREATE ROLE/, []],
    ["CREATE DATABASE", /^CREATE DATABASE/, ['DROP ROLE IF EXISTS "hs_my_app_owner"']],
    [
      "the baseline",
      /CREATE SCHEMA/,
      ['DROP DATABASE IF EXISTS "my_app" WITH (FORCE)', 'DROP ROLE IF EXISTS "hs_my_app_owner"'],
    ],
  ])("drops only what it created when %s fails", async (_label, failing, drops) => {
    failOn = failing;
    const response = await create();
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Could not create the project: boom");
    expect(html).not.toContain(ADMIN_PASSWORD);
    expect(statements.map((s) => s.sql).filter((sql) => sql.startsWith("DROP"))).toEqual(drops);
    expect(getProjectByRef(db, "my-app")).toBeUndefined();
    expect(refreshed).toEqual([]);
  });
});

describe("the new-project form", () => {
  it("preselects the shared box and warns on dev-only boxes", async () => {
    insertBox(db, {
      name: "prod-eu",
      kind: "registered",
      devOnly: false,
      host: "pg.internal",
      port: 5432,
      adminUser: "postgres",
      adminPasswordEnc: encryptSecret("x", secretKey),
      sslmode: "require",
      publicHost: "pg.example.test",
      publicPort: 5432,
      poolerTenant: null,
      poolerSessionPort: null,
      poolerTransactionPort: null,
      containerName: null,
    });
    const html = await (await app.request("/_hs/projects/new")).text();
    expect(html).toContain(
      `<option value="${sharedBoxId()}" selected="">shared — Best for development only — shares one Postgres with other projects</option>`,
    );
    expect(html).toMatch(/<option value="\d+">prod-eu<\/option>/);
    expect(html).toContain("const slugify = function slugify(name)");
  });
});

describe("the project pages", () => {
  it("lists active projects as cards that open Studio, with the project page in the menu", async () => {
    await create();
    const html = await (await app.request("/_hs/projects")).text();
    expect(html).toContain('class="project-grid"');
    expect(html).toContain('data-project="my-app"');
    expect(html).toContain('<a class="project-link" href="/project/my-app/editor">My App</a>');
    expect(html).toContain('href="/_hs/projects/my-app/settings">Project settings</a>');
    expect(html).toContain('href="/_hs/projects/my-app/settings#delete"');
    expect(html).toContain("shared · dev");
    expect(html).toContain(">Active</span>");
    expect(html).not.toContain(ownerPassword("my-app"));
  });

  it("switches to the list view and remembers it", async () => {
    await create();
    const list = await app.request("/_hs/projects?view=list");
    expect(await list.text()).toContain('class="table project-table"');
    const cookie = list.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hs_projects_view=list");
    const again = await app.request("/_hs/projects", {
      headers: { cookie: cookie.split(";")[0] as string },
    });
    expect(await again.text()).toContain('class="table project-table"');
  });

  it("hides projects the search does not match and sorts newest first", async () => {
    await create();
    await create("billing", "Billing");
    const setCreated = db.prepare("UPDATE projects SET created_at = ? WHERE ref = ?");
    setCreated.run("2026-01-01T00:00:00.000Z", "billing");
    setCreated.run("2026-10-21T00:00:00.000Z", "my-app");
    const searched = await (await app.request("/_hs/projects?q=bill")).text();
    expect(searched).toMatch(/data-project="billing" data-search="billing billing">/);
    expect(searched).toMatch(/data-project="my-app" data-search="my app my-app" hidden="">/);
    expect(searched).toContain('id="no-matches" hidden=""');

    const byName = await (await app.request("/_hs/projects")).text();
    expect(byName.indexOf('data-project="billing"')).toBeLessThan(
      byName.indexOf('data-project="my-app"'),
    );
    const newest = await (await app.request("/_hs/projects?sort=created")).text();
    expect(newest.indexOf('data-project="my-app"')).toBeLessThan(
      newest.indexOf('data-project="billing"'),
    );
  });

  it("answers database sizes per project and per box, and marks a failing box unreachable", async () => {
    await create();
    databaseSizes = [["my_app", "8192000"]];
    const boxId = Number(sharedBoxId());
    expect(await (await app.request("/_hs/usage")).json()).toEqual({
      boxes: { [boxId]: { reachable: true, bytes: 8192000 } },
      projects: { "my-app": 8192000 },
    });
    expect(statements.at(-1)?.sql).toContain("pg_database_size");

    failOn = /pg_database_size/;
    expect(await (await app.request("/_hs/usage")).json()).toEqual({
      boxes: { [boxId]: { reachable: false, bytes: 0 } },
      projects: {},
    });
  });

  it("shows masked pooler strings with the real one only behind Reveal/Copy", async () => {
    await create();
    const password = ownerPassword("my-app");
    const html = await (await app.request("/_hs/projects/my-app")).text();
    expect(html).toContain(
      `data-url="postgresql://hs_my_app_owner.hattisar:${password}@db.example.test:54322/my_app"`,
    );
    expect(html).toContain(
      ">postgresql://hs_my_app_owner.hattisar:••••••••@db.example.test:6543/my_app</code>",
    );
    expect(html.split(password)).toHaveLength(3);
    expect(html).toContain('href="/project/my-app/editor"');
  });

  it("answers unknown and deleted projects with 404", async () => {
    await create();
    markProjectDeleted(db, getProjectByRef(db, "my-app")?.id ?? 0, "my_app__deleted_20261020");
    expect((await app.request("/_hs/projects/my-app")).status).toBe(404);
    expect((await app.request("/_hs/projects/nope")).status).toBe(404);
    expect((await post("/_hs/projects/my-app/rotate", {})).status).toBe(404);
    expect(await (await app.request("/_hs/projects")).text()).not.toContain("my-app");
  });

  it.each([
    ["/_hs/projects/my-app", "Connect", "Connection strings", "Back up now"],
    ["/_hs/projects/my-app/backups", "Backups", "Back up now", "Connection strings"],
    ["/_hs/projects/my-app/settings", "General", "Delete project", "Back up now"],
  ])("renders %s as the %s tab only", async (path, label, shown, absent) => {
    await create();
    const html = await (await app.request(path)).text();
    expect(html).toContain(`aria-current="page">${label}</a>`);
    expect(html).toContain(shown);
    expect(html).not.toContain(absent);
    expect(html).toContain('<a href="/_hs/projects">Projects</a>');
  });

  it("returns each form to its own tab", async () => {
    await create();
    const renamed = await post("/_hs/projects/my-app/name", { name: "Renamed" });
    expect(renamed.headers.get("location")).toBe("/_hs/projects/my-app/settings?renamed");
    const refused = await post("/_hs/projects/my-app/delete", { confirm: "wrong" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('aria-current="page">General</a>');
  });

  it("renames the display name and refuses an empty one", async () => {
    await create();
    expect((await post("/_hs/projects/my-app/name", { name: "Renamed" })).status).toBe(302);
    expect(getProjectByRef(db, "my-app")?.name).toBe("Renamed");
    const refused = await post("/_hs/projects/my-app/name", { name: "  " });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Name is required");
  });
});

describe("rotating the owner password", () => {
  it("alters the role with a new verifier and stores the new password", async () => {
    await create();
    const before = ownerPassword("my-app");
    statements = [];
    const response = await post("/_hs/projects/my-app/rotate", {});
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/projects/my-app?rotated");
    const after = ownerPassword("my-app");
    expect(after).not.toBe(before);
    expect(statements.map((s) => s.sql)).toEqual([
      expect.stringMatching(/^ALTER ROLE "hs_my_app_owner" PASSWORD 'SCRAM-SHA-256\$4096:[^']+'$/),
    ]);
    expect(statements[0]?.sql).not.toContain(after);
    expect(refreshed.at(-1)).toEqual({ ref: "my-app", password: after });

    const html = await (await app.request("/_hs/projects/my-app?rotated")).text();
    expect(html).toContain("Password rotated.");
    expect(html).toContain(after);
  });

  it("keeps the stored password when the box refuses", async () => {
    await create();
    const before = ownerPassword("my-app");
    failOn = /^ALTER ROLE/;
    const response = await post("/_hs/projects/my-app/rotate", {});
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Could not rotate the password: boom");
    expect(ownerPassword("my-app")).toBe(before);
  });
});

describe("a project whose owner password will not decrypt", () => {
  async function createUnreadable(): Promise<void> {
    await create();
    const project = getProjectByRef(db, "my-app");
    const otherKey = deriveSecretKey("q".repeat(32));
    setProjectOwnerPassword(db, project?.id ?? 0, encryptSecret("lost", otherKey));
  }

  it("still renders its page, explaining the missing connection strings", async () => {
    await createUnreadable();
    const response = await app.request("/_hs/projects/my-app");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("cannot be decrypted");
    expect(html).not.toContain("postgresql://");
    expect(html).toContain('action="/_hs/projects/my-app/rotate"');
  });

  it("rotates to a fresh password without reading the old one", async () => {
    await createUnreadable();
    const response = await post("/_hs/projects/my-app/rotate", {});
    expect(response.status).toBe(302);
    const after = ownerPassword("my-app");
    expect(refreshed.at(-1)).toEqual({ ref: "my-app", password: after });
    expect(await (await app.request("/_hs/projects/my-app")).text()).toContain(after);
  });
});
