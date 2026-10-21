import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { createApiToken } from "../../src/auth/api-tokens.js";
import { hashToken } from "../../src/auth/sessions.js";
import { loadConfig } from "../../src/config.js";
import { getApiTokenByHash } from "../../src/registry/api-tokens.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { signInToRegistry } from "../helpers/session.js";

const ORIGIN = "http://hattisar.test";
const NO_TOKEN = { error: { message: "Missing or invalid API token" } };

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
    adminPasswordEnc: "not-a-real-ciphertext",
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

  it("does not refuse a cross-origin POST with a bearer token", async () => {
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

  it("never serves an encoded API path to Studio without a session", async () => {
    const response = await request("/_hs/api%2Fv1/me");
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
