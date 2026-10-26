import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AdminClientRunner, BoxConnection } from "../../src/boxes/admin-client.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import {
  attachableDatabases,
  attachedConnection,
  attachedProblem,
  attachProject,
  detachProject,
  updateProjectLogin,
} from "../../src/projects/attach.js";
import type { LifecycleHook, ProjectServiceDeps } from "../../src/projects/service.js";
import { insertBackup } from "../../src/registry/backups.js";
import { type Box, getSharedBox, insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import {
  getProjectByRef,
  insertProject,
  markProjectDeleted,
  type Project,
} from "../../src/registry/projects.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";

const secretKey = deriveSecretKey("a".repeat(32));
const ADMIN_PASSWORD = "box-admin-secret";
const LOGIN_PASSWORD = "app-login-secret";

interface Call {
  conn: BoxConnection;
  database: string | undefined;
  sql: string[];
}

let dataDir: string;
let db: Registry;
let registered: Box;
let calls: Call[];
let listed: string[];
let superuser: boolean;
let loginFails: boolean;
let onLifecycle: Mock<LifecycleHook>;
let deps: ProjectServiceDeps;

const fakeAdmin: AdminClientRunner = async (conn, run, database) => {
  const call: Call = { conn, database, sql: [] };
  calls.push(call);
  const client = {
    query: async (text: string) => {
      call.sql.push(text);
      if (text.startsWith("select datname from pg_database")) {
        return { rowCount: listed.length, rows: listed.map((datname) => ({ datname })) };
      }
      if (text.startsWith("select rolsuper")) {
        if (loginFails) throw new Error(`password authentication failed (${conn.password})`);
        return { rowCount: 1, rows: [{ rolsuper: superuser }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return run(client as unknown as pg.Client);
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-attach-"));
  db = openRegistry(dataDir);
  seedSharedBox(
    db,
    loadConfig({
      HATTISAR_SECRET_KEY: "a".repeat(32),
      PG_META_CRYPTO_KEY: "unit",
      POSTGRES_PASSWORD: ADMIN_PASSWORD,
      POOLER_TENANT_ID: "hattisar",
      POOLER_JWT_SECRET: "pooler-jwt-secret",
    }),
    secretKey,
  );
  registered = insertBox(db, {
    name: "rds",
    kind: "registered",
    devOnly: false,
    host: "pg.internal",
    port: 5433,
    adminUser: "rdsadmin",
    adminPasswordEnc: encryptSecret(ADMIN_PASSWORD, secretKey),
    sslmode: "require",
    publicHost: "pg.example.test",
    publicPort: 5433,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
    adminSuperuser: false,
  });
  calls = [];
  listed = ["legacy", "shop", "taken", "trashed"];
  superuser = false;
  loginFails = false;
  onLifecycle = vi.fn<LifecycleHook>(async () => undefined);
  deps = {
    db,
    secretKey,
    admin: fakeAdmin,
    refreshPooler: vi.fn(async () => {}),
    poolerHost: "localhost",
    onLifecycle,
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function form(overrides: Partial<Parameters<typeof attachProject>[1]> = {}) {
  return {
    name: "Shop",
    ref: "shop",
    boxId: registered.id,
    database: "shop",
    login: "shop_app",
    password: LOGIN_PASSWORD,
    ...overrides,
  };
}

function createdProject(ref: string, dbName: string): Project {
  return insertProject(db, {
    ref,
    name: ref,
    boxId: registered.id,
    dbName,
    ownerRole: `hs_${dbName}_owner`,
    ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
  });
}

async function attached(): Promise<Project> {
  const result = await attachProject(deps, form());
  if (!result.ok) throw new Error(result.problems.join("; "));
  calls = [];
  return result.project;
}

describe("attachableDatabases", () => {
  it("drops databases of created projects and Trash names", async () => {
    createdProject("taken-app", "taken");
    const trashed = createdProject("trashed-app", "trashed_app");
    markProjectDeleted(db, trashed.id, "trashed");
    expect(await attachableDatabases(deps, registered)).toEqual({
      ok: true,
      databases: ["legacy", "shop"],
    });
    expect(calls[0]?.database).toBeUndefined();
    expect(calls[0]?.sql[0]).toContain("not datistemplate");
    expect(calls[0]?.sql[0]).toContain("'_supabase'");
  });

  it("asks for no name that cannot go raw into a connection URL path", async () => {
    await attachableDatabases(deps, registered);
    expect(calls[0]?.sql[0]).toContain("and datname !~ '[/?#%]'");
  });

  it("refuses the shared box with the exact problem", async () => {
    const shared = getSharedBox(db) as Box;
    expect(await attachableDatabases(deps, shared)).toEqual({
      ok: false,
      problem: `Only registered boxes can attach databases; ${shared.name} is shared.`,
    });
    expect(calls).toEqual([]);
  });

  it("refuses a managed box", async () => {
    const managed = { ...registered, kind: "managed" as const };
    expect(await attachableDatabases(deps, managed)).toEqual({
      ok: false,
      problem: `Only registered boxes can attach databases; ${managed.name} is managed.`,
    });
  });

  it("reports a failing box with the password scrubbed", async () => {
    const failing: AdminClientRunner = async (conn) => {
      throw new Error(`connect refused (${conn.password})`);
    };
    const result = await attachableDatabases({ ...deps, admin: failing }, registered);
    expect(result).toEqual({
      ok: false,
      problem: "Could not list the databases of box rds: connect refused (********)",
    });
  });
});

describe("attachProject", () => {
  it.each(["a/b", "a?b", "a#b", "a%b"])(
    "refuses the database %s the box did not offer",
    async (name) => {
      const result = await attachProject(deps, form({ database: name }));
      expect(result).toEqual({
        ok: false,
        problems: [`Database ${name} cannot be attached on box rds`],
      });
      expect(getProjectByRef(db, "shop")).toBeUndefined();
    },
  );

  it("stores an attached project and reads only the database list and rolsuper", async () => {
    superuser = true;
    const result = await attachProject(deps, form());
    expect(result.ok).toBe(true);
    const stored = getProjectByRef(db, "shop") as Project;
    expect(stored).toMatchObject({
      kind: "attached",
      dbName: "shop",
      ownerRole: "shop_app",
      loginSuperuser: true,
      boxId: registered.id,
    });
    expect(decryptSecret(stored.ownerPasswordEnc, secretKey)).toBe(LOGIN_PASSWORD);
    const texts = calls.flatMap((call) => call.sql);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("from pg_database");
    expect(texts[1]).toBe("select rolsuper from pg_roles where rolname = current_user");
    expect(texts.some((text) => /^\s*(CREATE|ALTER|DROP|GRANT|REVOKE)/i.test(text))).toBe(false);
    expect(deps.refreshPooler).not.toHaveBeenCalled();
  });

  it("connects as the login to the chosen database", async () => {
    await attachProject(deps, form());
    expect(calls[1]).toMatchObject({
      conn: {
        host: "pg.internal",
        port: 5433,
        sslmode: "require",
        user: "shop_app",
        password: LOGIN_PASSWORD,
      },
      database: "shop",
    });
  });

  it("scrubs the password from a failed login and stores nothing", async () => {
    loginFails = true;
    const result = await attachProject(deps, form());
    expect(result.ok).toBe(false);
    const problem = result.ok ? "" : (result.problems[0] as string);
    expect(problem).toMatch(/^Could not log in to shop as shop_app: /);
    expect(problem).toContain("********");
    expect(problem).not.toContain(LOGIN_PASSWORD);
    expect(getProjectByRef(db, "shop")).toBeUndefined();
  });

  it("refuses a database a created project uses, even when sent directly", async () => {
    createdProject("taken-app", "taken");
    expect(await attachProject(deps, form({ database: "taken" }))).toEqual({
      ok: false,
      problems: ["Database taken cannot be attached on box rds"],
    });
  });

  it("refuses a taken ref", async () => {
    createdProject("shop", "other");
    expect(await attachProject(deps, form())).toEqual({
      ok: false,
      problems: ["Ref shop is already taken"],
    });
  });

  it("asks for a login and a password", async () => {
    expect(await attachProject(deps, form({ login: "", password: "" }))).toEqual({
      ok: false,
      problems: ["Login is required", "Password is required"],
    });
  });

  it("refuses the shared box and a missing box", async () => {
    const shared = getSharedBox(db) as Box;
    const onShared = await attachProject(deps, form({ boxId: shared.id }));
    expect(onShared.ok).toBe(false);
    expect(await attachProject(deps, form({ boxId: 9999 }))).toEqual({
      ok: false,
      problems: ["Choose a box"],
    });
    expect(calls).toEqual([]);
  });
});

describe("updateProjectLogin", () => {
  it("swaps the login, password and superuser flag after the connect check", async () => {
    const project = await attached();
    superuser = true;
    expect(await updateProjectLogin(deps, project, registered, "new_login", "new-pw")).toEqual({
      ok: true,
    });
    const stored = getProjectByRef(db, "shop") as Project;
    expect(stored).toMatchObject({ ownerRole: "new_login", loginSuperuser: true });
    expect(decryptSecret(stored.ownerPasswordEnc, secretKey)).toBe("new-pw");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conn: { user: "new_login", password: "new-pw" },
      database: "shop",
    });
    expect(calls[0]?.sql).toEqual(["select rolsuper from pg_roles where rolname = current_user"]);
  });

  it("keeps the old login when the new one cannot connect", async () => {
    const project = await attached();
    loginFails = true;
    const result = await updateProjectLogin(deps, project, registered, "new_login", "new-pw");
    expect(result.ok).toBe(false);
    expect(getProjectByRef(db, "shop")?.ownerRole).toBe("shop_app");
  });

  it("refuses a created project", async () => {
    const created = createdProject("my-app", "my_app");
    expect(await updateProjectLogin(deps, created, registered, "x", "y")).toEqual({
      ok: false,
      problem: "my-app was created by hattisar; rotate its password instead.",
    });
    expect(calls).toEqual([]);
  });

  it("refuses while a backup is running", async () => {
    const project = await attached();
    insertBackup(db, { projectId: project.id, kind: "manual", bucket: "b", s3Key: "k" });
    expect(await updateProjectLogin(deps, project, registered, "x", "y")).toEqual({
      ok: false,
      problem:
        "Can't update the login of shop while a backup of it is running. Try again when it finishes.",
    });
    expect(calls).toEqual([]);
  });
});

describe("detachProject", () => {
  it("removes the row without touching the box", async () => {
    const project = await attached();
    expect(await detachProject(deps, project)).toEqual({ ok: true });
    expect(getProjectByRef(db, "shop")).toBeUndefined();
    expect(calls).toEqual([]);
    expect(onLifecycle).not.toHaveBeenCalled();
  });

  it("refuses a created project", async () => {
    const created = createdProject("my-app", "my_app");
    expect(await detachProject(deps, created)).toEqual({
      ok: false,
      problem: "my-app was created by hattisar; delete it instead.",
    });
    expect(getProjectByRef(db, "my-app")).toBeDefined();
  });

  it("refuses while a backup is running", async () => {
    const project = await attached();
    insertBackup(db, { projectId: project.id, kind: "manual", bucket: "b", s3Key: "k" });
    const result = await detachProject(deps, project);
    expect(result).toMatchObject({ ok: false });
    expect(getProjectByRef(db, "shop")).toBeDefined();
  });
});

describe("attachedConnection", () => {
  it("uses the box address with the stored login and decrypted password", async () => {
    const project = await attached();
    expect(attachedConnection(project, registered, secretKey)).toEqual({
      host: "pg.internal",
      port: 5433,
      sslmode: "require",
      user: "shop_app",
      password: LOGIN_PASSWORD,
    });
  });
});

describe("attachedProblem", () => {
  it("names the ref", () => {
    expect(attachedProblem("shop")).toBe("shop is attached; detach it instead.");
  });
});
