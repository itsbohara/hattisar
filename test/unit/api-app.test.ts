import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../../src/api/routes.js";
import { createApp } from "../../src/app.js";
import { createApiToken } from "../../src/auth/api-tokens.js";
import { hashToken } from "../../src/auth/sessions.js";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { loadConfig } from "../../src/config.js";
import { holdingProject } from "../../src/projects/locks.js";
import { getApiTokenByHash } from "../../src/registry/api-tokens.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { getProjectByRef, setProjectOwnerPassword } from "../../src/registry/projects.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { API_PREFIX } from "../../src/studio/routes.js";
import { signInToRegistry } from "../helpers/session.js";

const ORIGIN = "http://hattisar.test";
const NO_TOKEN = { error: { message: "Missing or invalid API token" } };
const secretKey = deriveSecretKey("s".repeat(32));
const BOX_ADMIN_PASSWORD = "box-admin-secret";

let dataDir: string;
let db: Registry;
let app: ReturnType<typeof createApp>;
let cookie: string;
let token: string;

function mint(expiryDays: 30 | null = 30, now?: Date): string {
  const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number };
  const created = createApiToken(db, user.id, "cli", expiryDays, now);
  if (!created.ok) throw new Error(created.problem);
  return created.token;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-api-app-"));
  db = openRegistry(dataDir);
  cookie = signInToRegistry(db);
  token = mint();
  insertBox(db, {
    name: "shared",
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: encryptSecret(BOX_ADMIN_PASSWORD, secretKey),
    sslmode: "disable",
    publicHost: "localhost",
    publicPort: 54322,
    poolerTenant: "hattisar",
    poolerSessionPort: 54322,
    poolerTransactionPort: 6543,
    containerName: "hs-db",
  });
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: "s".repeat(32),
      PG_META_CRYPTO_KEY: "unit-test-crypto-key",
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      STUDIO_URL: "http://127.0.0.1:9",
    }),
    db,
  );
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function request(path: string, headers: Record<string, string> = {}, method = "GET") {
  return app.request(`${ORIGIN}${path}`, { method, headers });
}

const bearer = (value = token) => ({ authorization: `Bearer ${value}` });

describe("API authentication", () => {
  it("answers /me for a bearer token", async () => {
    const response = await request("/_hs/api/v1/me", bearer());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: "admin" });
  });

  it("accepts the scheme in any case", async () => {
    const response = await request("/_hs/api/v1/me", { authorization: `bearer ${token}` });
    expect(response.status).toBe(200);
  });

  it.each([
    ["no credentials", {}],
    ["the session cookie alone", () => ({ cookie })],
    ["an unknown token", () => bearer(`hs_${"x".repeat(43)}`)],
    ["a session token as bearer", () => bearer(cookie.split("=")[1])],
    ["a Basic header", () => ({ authorization: `Basic ${token}` })],
  ])("answers 401 JSON for %s", async (_, headers) => {
    const response = await request(
      "/_hs/api/v1/me",
      typeof headers === "function" ? headers() : headers,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(NO_TOKEN);
  });

  it("answers 401 for an expired token and deletes it", async () => {
    const expired = mint(30, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    const response = await request("/_hs/api/v1/me", bearer(expired));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(NO_TOKEN);
    expect(getApiTokenByHash(db, hashToken(expired))).toBeUndefined();
  });

  it("lets a cross-origin POST with a bearer token reach the router", async () => {
    const response = await request(
      "/_hs/api/v1/me",
      { ...bearer(), origin: "http://evil.test" },
      "POST",
    );
    expect(response.status).not.toBe(403);
    expect(response.status).toBe(404);
  });

  it.each(["/_hs/api/v1/nope", "/_hs/static/../api/v1/me"])(
    "asks for the token before answering %s",
    async (path) => {
      expect((await request(path)).status).toBe(401);
    },
  );

  it.each(["/_hs/api", "/_hs/api/v1/nope", "/_hs/api/v2/me", "/_hs/api/v1"])(
    "answers unknown %s with 404 JSON",
    async (path) => {
      const response = await request(path, bearer());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { message: "Not found" } });
    },
  );

  it("answers a cookie-only cross-origin POST with 401, not an action", async () => {
    const response = await request(
      "/_hs/api/v1/me",
      { cookie, origin: "http://evil.test" },
      "POST",
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(NO_TOKEN);
  });

  it.each(["/_HS/API/v1/me", "//_hs/api/v1/me", "/_hs/api%2Fv1/me", "/_hs%2Fapi/v1/me"])(
    "asks %s for a session, not a token",
    async (path) => {
      const response = await request(path, bearer());
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/_hs/login");
    },
  );

  it.each(["/_hs/api%2Fv1/me", "/_hs%2Fapi/v1/me"])(
    "refuses a cross-origin POST to %s like any hattisar path",
    async (path) => {
      const response = await request(
        path,
        { ...bearer(), cookie, origin: "http://evil.test" },
        "POST",
      );
      expect(response.status).toBe(403);
    },
  );

  it("never serves an encoded API path to Studio, even with a session", async () => {
    const response = await request("/_hs/api%2Fv1/me", { cookie });
    expect(response.status).toBe(404);
  });
});

describe("bearer tokens outside the API", () => {
  it("redirects a hattisar page to the login page", async () => {
    const response = await request("/_hs/projects", bearer());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/login");
  });

  it("answers a Studio API path with 401 Not signed in", async () => {
    const response = await request("/api/platform/projects", bearer());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: "Not signed in" } });
  });

  it("still refuses a cross-origin POST outside the API", async () => {
    const response = await request(
      "/_hs/logout",
      { ...bearer(), cookie, origin: "http://evil.test" },
      "POST",
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /boxes", () => {
  it("lists only the public fields", async () => {
    const response = await request("/_hs/api/v1/boxes", bearer());
    expect(response.status).toBe(200);
    const boxes = (await response.json()) as Record<string, unknown>[];
    expect(boxes).toHaveLength(1);
    expect(Object.keys(boxes[0] ?? {}).sort()).toEqual(
      ["devOnly", "id", "kind", "name", "publicHost", "publicPort"].sort(),
    );
    expect(boxes[0]).toMatchObject({
      name: "shared",
      kind: "shared",
      devOnly: true,
      publicHost: "localhost",
      publicPort: 54322,
    });
  });
});

describe("unexpected errors", () => {
  it("answers an API path with a JSON 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.exec("ALTER TABLE boxes RENAME TO boxes_away");
    try {
      const response = await request("/_hs/api/v1/boxes", bearer());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { message: "Internal error" } });
    } finally {
      db.exec("ALTER TABLE boxes_away RENAME TO boxes");
      spy.mockRestore();
    }
  });
});

describe("projects", () => {
  let statements: string[];
  let failOn: RegExp | undefined;
  let api: Hono;

  const fakeAdmin: AdminClientRunner = async (_conn, run) => {
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (failOn?.test(sql)) throw new Error("boom");
        return { rowCount: 0, rows: [] };
      },
    };
    return run(client as unknown as pg.Client);
  };

  beforeEach(() => {
    statements = [];
    failOn = undefined;
    api = new Hono();
    api.route(
      API_PREFIX,
      apiRoutes({ db, secretKey, admin: fakeAdmin, refreshPooler: async () => {} }),
    );
  });

  function call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = bearer();
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    return Promise.resolve(
      api.request(`${ORIGIN}${API_PREFIX}/v1${path}`, { method, headers, body: payload }),
    );
  }

  async function create(body: unknown = { name: "My App", ref: "my-app" }) {
    const response = await call("POST", "/projects", body);
    expect(response.status).toBe(201);
    return response;
  }

  async function problems(response: Response, status = 400) {
    expect(response.status).toBe(status);
    return ((await response.json()) as { error: { problems?: string[] } }).error.problems;
  }

  it("creates a project on the shared box and answers 201 with it", async () => {
    const response = await create();
    const body = await response.json();
    expect(body).toEqual({
      ref: "my-app",
      name: "My App",
      status: "active",
      box: { id: expect.any(Number), name: "shared", kind: "shared" },
      createdAt: expect.any(String),
      deletedAt: null,
    });
    expect(statements).toContain('CREATE DATABASE "my_app" OWNER "hs_my_app_owner"');
  });

  it("defaults the ref to the slugified name", async () => {
    const response = await create({ name: "Héllo World!" });
    expect(await response.json()).toMatchObject({ ref: "hello-world", name: "Héllo World!" });
  });

  it("answers a duplicate ref with 400 and the service's problems", async () => {
    await create();
    const response = await call("POST", "/projects", { name: "Again", ref: "my-app" });
    expect(await problems(response)).toEqual(["Ref my-app is already taken"]);
  });

  it.each([
    ["no body", undefined, ["Body must be a JSON object."]],
    ["invalid JSON", "{nope", ["Body must be a JSON object."]],
    ["an array", [], ["Body must be a JSON object."]],
    [
      "wrong field types",
      { name: 1, ref: false, boxId: "1", newBox: "yes" },
      [
        "name must be a string.",
        "ref must be a string.",
        "boxId must be an integer.",
        "newBox must be a boolean.",
      ],
    ],
    [
      "newBox with managed boxes off",
      { name: "x", newBox: true },
      ["Managed boxes are not enabled."],
    ],
    [
      "newBox with a boxId",
      { name: "x", newBox: true, boxId: 1 },
      ["Give either boxId or newBox, not both."],
    ],
  ])("answers a create with %s with 400", async (_, body, expected) => {
    expect(await problems(await call("POST", "/projects", body))).toEqual(expected);
    expect(statements).toEqual([]);
  });

  it("shows a project with masked connection strings and their kinds", async () => {
    await create();
    const response = await call("GET", "/projects/my-app");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connections: Record<string, string>[] };
    expect(body).toMatchObject({ ref: "my-app", status: "active" });
    expect(body.connections.map(({ label, kind }) => [label, kind])).toEqual([
      ["Session pooler", "session"],
      ["Transaction pooler", "transaction"],
    ]);
    expect(body.connections[0]?.masked).toContain("••••••••");
    expect(JSON.stringify(body)).not.toContain(passwordOf("my-app"));
  });

  it("holds the real password only under /connections", async () => {
    await create();
    const response = await call("GET", "/projects/my-app/connections");
    expect(response.status).toBe(200);
    const password = encodeURIComponent(passwordOf("my-app"));
    expect(await response.json()).toEqual([
      {
        label: "Session pooler",
        kind: "session",
        url: `postgresql://hs_my_app_owner.hattisar:${password}@localhost:54322/my_app`,
      },
      {
        label: "Transaction pooler",
        kind: "transaction",
        url: `postgresql://hs_my_app_owner.hattisar:${password}@localhost:6543/my_app`,
      },
    ]);
  });

  it("keeps show usable but answers /connections 502 when the password will not decrypt", async () => {
    await create();
    const project = getProjectByRef(db, "my-app");
    setProjectOwnerPassword(
      db,
      project?.id ?? 0,
      encryptSecret("lost", deriveSecretKey("q".repeat(32))),
    );
    const shown = await call("GET", "/projects/my-app");
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ connections: [] });
    const connections = await call("GET", "/projects/my-app/connections");
    expect(connections.status).toBe(502);
    expect(await connections.json()).toEqual({
      error: { message: "The project's password could not be decrypted. Rotate it to repair." },
    });
  });

  it("rotates the owner password", async () => {
    await create();
    const before = passwordOf("my-app");
    const response = await call("POST", "/projects/my-app/rotate");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(passwordOf("my-app")).not.toBe(before);
  });

  it("answers a rotate the box refuses with 502", async () => {
    await create();
    failOn = /^ALTER ROLE/;
    const response = await call("POST", "/projects/my-app/rotate");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: "Could not rotate the password: boom" },
    });
  });

  it.each([
    ["without a body", undefined, ["Body must be a JSON object."]],
    ["without confirm", {}, ["Type the ref my-app to confirm deleting the project."]],
    [
      "with the wrong confirm",
      { confirm: "other" },
      ["Type the ref my-app to confirm deleting the project."],
    ],
  ])("refuses a delete %s", async (_, body, expected) => {
    await create();
    expect(await problems(await call("DELETE", "/projects/my-app", body))).toEqual(expected);
    expect(getProjectByRef(db, "my-app")?.status).toBe("active");
  });

  it("soft deletes, lists the project as deleted, and undeletes it", async () => {
    await create();
    const deleted = await call("DELETE", "/projects/my-app", { confirm: "my-app" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await call("GET", "/projects/my-app")).status).toBe(404);
    expect(await (await call("GET", "/projects")).json()).toEqual([]);

    const trash = (await (await call("GET", "/projects?status=deleted")).json()) as unknown[];
    expect(trash).toEqual([
      expect.objectContaining({ ref: "my-app", status: "deleted", deletedAt: expect.any(String) }),
    ]);

    const restored = await call("POST", "/projects/my-app/undelete");
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      ref: "my-app",
      status: "active",
      deletedAt: null,
    });
    expect((await call("GET", "/projects/my-app")).status).toBe(200);
  });

  it("answers undelete of an active project with 404", async () => {
    await create();
    expect((await call("POST", "/projects/my-app/undelete")).status).toBe(404);
  });

  it("refuses an unknown status filter", async () => {
    expect(await problems(await call("GET", "/projects?status=all"))).toEqual([
      "status must be active or deleted.",
    ]);
  });

  it.each([
    ["GET", "/projects/nope"],
    ["GET", "/projects/nope/connections"],
    ["POST", "/projects/nope/rotate"],
    ["DELETE", "/projects/nope"],
    ["POST", "/projects/nope/undelete"],
  ])("answers %s %s for an unknown ref with 404", async (method, path) => {
    const response = await call(
      method,
      path,
      method === "DELETE" ? { confirm: "nope" } : undefined,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: "Not found" } });
  });

  it("answers 409 while another operation holds the project", async () => {
    await create();
    const project = getProjectByRef(db, "my-app");
    if (project === undefined) throw new Error("no project");
    const operation = {
      action: "restore",
      holds: "it is being restored",
      status: "active" as const,
    };
    await holdingProject(db, project, operation, async () => {
      const response = await call("DELETE", "/projects/my-app", { confirm: "my-app" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          message: "Can't delete my-app while it is being restored. Try again when it finishes.",
        },
      });
    });
  });
});

function passwordOf(ref: string): string {
  return decryptSecret(getProjectByRef(db, ref)?.ownerPasswordEnc ?? "", secretKey);
}
