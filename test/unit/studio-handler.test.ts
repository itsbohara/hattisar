import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CryptoJS from "crypto-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject, markProjectDeleted } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { proxyToStudio } from "../../src/studio/proxy.js";
import { signInToRegistry } from "../helpers/session.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const cryptoKey = "unit-test-crypto-key";
const secretKey = deriveSecretKey("s".repeat(32));

function seedProjects(db: Registry): void {
  const box = insertBox(db, {
    name: "shared",
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: encryptSecret("pw", secretKey),
    sslmode: "disable",
    publicHost: "db.example.test",
    publicPort: 54322,
    poolerTenant: "hattisar",
    poolerSessionPort: 54322,
    poolerTransactionPort: 6543,
    containerName: null,
  });
  for (const ref of ["spike-b", "gone"]) {
    const dbName = ref.replace("-", "_");
    insertProject(db, {
      ref,
      name: ref,
      boxId: box.id,
      dbName,
      ownerRole: `hs_${dbName}_owner`,
      ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
    });
  }
  const gone = db.prepare("SELECT id FROM projects WHERE ref = 'gone'").get() as { id: number };
  markProjectDeleted(db, gone.id, "gone__deleted_20261020");
  const east = insertBox(db, {
    name: "east",
    kind: "registered",
    devOnly: false,
    host: "east-db",
    port: 5432,
    adminUser: "postgres",
    adminPasswordEnc: encryptSecret("pw", secretKey),
    sslmode: "require",
    publicHost: "east.example.test",
    publicPort: 5433,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
  });
  insertProject(db, {
    ref: "spike-c",
    name: "spike-c",
    boxId: east.id,
    dbName: "spike_c",
    ownerRole: "hs_spike_c_owner",
    ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
  });
}

const STUDIO_SETTINGS = {
  app_config: { db_schema: "public", endpoint: "localhost:8000" },
  db_host: "localhost",
  db_name: "postgres",
  db_port: 5432,
  db_user: "postgres",
  name: "Default Project",
  ref: "default",
  service_api_keys: [{ api_key: "anon", name: "anon key", tags: "anon" }],
  ssl_enforced: false,
};

let studio: Server;
let studioUrl: string;
let seen: Seen[] = [];
let app: ReturnType<typeof createApp>;
let dataDir: string;
let registry: Registry;
let cookie: string;
let settingsResponse: { status: number; body: string };

beforeAll(async () => {
  studio = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/page") {
        const html = "<html><head></head><body></body>";
        res.writeHead(200, { "content-type": "text/html", "content-length": html.length });
        res.end(html);
      } else if (req.url?.endsWith("/settings")) {
        res.writeHead(settingsResponse.status, { "content-type": "application/json" });
        res.end(settingsResponse.body);
      } else if (req.url === "/moved") {
        res.writeHead(307, { location: "/elsewhere" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => studio.listen(0, "127.0.0.1", resolve));
  const { port } = studio.address() as AddressInfo;
  studioUrl = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-studio-handler-"));
  registry = openRegistry(dataDir);
  cookie = signInToRegistry(registry);
  seedProjects(registry);
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: "s".repeat(32),
      PG_META_CRYPTO_KEY: cryptoKey,
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      STUDIO_URL: studioUrl,
    }),
    registry,
  );
});

afterAll(() => {
  studio.close();
  registry.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  settingsResponse = { status: 200, body: JSON.stringify(STUDIO_SETTINGS) };
});

function request(path: string, init?: RequestInit): Promise<Response> {
  seen = [];
  const headers = new Headers(init?.headers);
  if (!headers.has("cookie")) headers.set("cookie", cookie);
  if (!headers.has("origin")) headers.set("origin", "http://hattisar.test");
  return Promise.resolve(app.request(`http://hattisar.test${path}`, { ...init, headers }));
}

describe("pg-meta pass-through", () => {
  it("strips the client's x-connection-encrypted and sets the project's", async () => {
    const response = await request("/api/platform/pg-meta/spike-b/tables?included_schemas=public", {
      headers: { "x-connection-encrypted": "client-supplied" },
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const header = seen[0]?.headers["x-connection-encrypted"];
    expect(typeof header).toBe("string");
    expect(CryptoJS.AES.decrypt(header as string, cryptoKey).toString(CryptoJS.enc.Utf8)).toBe(
      "postgresql://hs_spike_b_owner:owner-pw@db:5432/spike_b",
    );
    expect(seen[0]?.url).toBe("/api/platform/pg-meta/spike-b/tables?included_schemas=public");
  });

  it("carries the box's sslmode in the connection it sets", async () => {
    registry.prepare("UPDATE boxes SET sslmode = 'require' WHERE name = 'shared'").run();
    try {
      await request("/api/platform/pg-meta/spike-b/tables");
    } finally {
      registry.prepare("UPDATE boxes SET sslmode = 'disable' WHERE name = 'shared'").run();
    }
    const header = seen[0]?.headers["x-connection-encrypted"] as string;
    expect(CryptoJS.AES.decrypt(header, cryptoKey).toString(CryptoJS.enc.Utf8)).toBe(
      "postgresql://hs_spike_b_owner:owner-pw@db:5432/spike_b?sslmode=require",
    );
  });

  it.each(["nope", "gone"])(
    "answers an unknown or deleted ref (%s) with 404 and never reaches Studio",
    async (ref) => {
      const response = await request(`/api/platform/pg-meta/${ref}/tables`);
      expect(response.status).toBe(404);
      expect(seen).toHaveLength(0);
    },
  );
});

describe("registry-backed platform routes", () => {
  it("lists only active projects", async () => {
    const response = await request("/api/platform/projects");
    expect(await response.json()).toEqual([
      expect.objectContaining({ ref: "spike-b", region: "shared", status: "ACTIVE_HEALTHY" }),
      expect.objectContaining({ ref: "spike-c", region: "east", status: "ACTIVE_HEALTHY" }),
    ]);
  });

  it("describes the database with the box's public endpoint and the owner role", async () => {
    const response = await request("/api/platform/projects/spike-b/databases");
    expect(await response.json()).toEqual([
      expect.objectContaining({
        identifier: "spike-b",
        db_name: "spike_b",
        db_host: "db.example.test",
        db_port: 54322,
        db_user: "hs_spike_b_owner",
      }),
    ]);
  });
});

describe("project settings", () => {
  it.each([
    [
      "spike-b",
      {
        db_host: "db.example.test",
        db_port: 54322,
        db_name: "spike_b",
        db_user: "hs_spike_b_owner",
      },
      false,
    ],
    [
      "spike-c",
      {
        db_host: "east.example.test",
        db_port: 5433,
        db_name: "spike_c",
        db_user: "hs_spike_c_owner",
      },
      true,
    ],
  ])("answers %s with its own connection over Studio's stub", async (ref, connection, ssl) => {
    const response = await request(`/api/platform/projects/${ref}/settings`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...STUDIO_SETTINGS,
      ...connection,
      ref,
      name: ref,
      ssl_enforced: ssl,
    });
    expect(seen.map((s) => s.url)).toEqual([`/api/platform/projects/${ref}/settings`]);
  });

  it.each([
    ["an error status", { status: 500, body: JSON.stringify(STUDIO_SETTINGS) }],
    ["a body that is not JSON", { status: 200, body: "<html>" }],
    ["a body that is not an object", { status: 200, body: "[]" }],
  ])("answers 502 when Studio's stub comes back with %s", async (_, stub) => {
    settingsResponse = stub;
    const response = await request("/api/platform/projects/spike-b/settings");
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("postgres");
  });

  it.each(["nope", "gone"])(
    "answers an unknown or deleted ref (%s) with 404 and never reaches Studio",
    async (ref) => {
      const response = await request(`/api/platform/projects/${ref}/settings`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Project not found" });
      expect(seen).toHaveLength(0);
    },
  );
});

it("answers a missing hattisar static file with 404, signed in or not", async () => {
  const anonymous = await app.request("http://hattisar.test/_hs/static/nope.css");
  expect(anonymous.status).toBe(404);
  expect((await request("/_hs/static/nope.css")).status).toBe(404);
});

describe("run-lints", () => {
  it("answers with no lints without reaching Studio", async () => {
    const response = await request("/api/platform/projects/spike-b/run-lints");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("answers an unknown ref with 404", async () => {
    expect((await request("/api/platform/projects/nope/run-lints")).status).toBe(404);
  });
});

describe("Studio pass-through", () => {
  it("preserves method, body and query and rewrites Host", async () => {
    await request("/api/platform/profile?x=1", { method: "POST", body: "payload" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/platform/profile?x=1" });
    expect(seen[0]?.body).toBe("payload");
    expect(seen[0]?.headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(seen[0]?.headers["accept-encoding"]).toBe("identity");
  });

  it("does not follow redirects", async () => {
    const response = await request("/moved");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/elsewhere");
  });

  it("injects hattisar's assets into HTML and drops Content-Length", async () => {
    const response = await request("/page");
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe(
      '<html><head><link rel="stylesheet" href="/_hs/static/studio.css"><script src="/_hs/static/studio.js" defer></script></head><body></body>',
    );
  });

  it("strips the session cookie and keeps the others", async () => {
    await request("/api/platform/profile", { headers: { cookie: `theme=dark; ${cookie}; a=b` } });
    expect(seen[0]?.headers.cookie).toBe("theme=dark; a=b");
  });

  it("sends no cookie header when the session was the only cookie", async () => {
    await request("/api/platform/profile");
    expect(seen[0]?.headers).not.toHaveProperty("cookie");
  });

  it("strips a client x-connection-encrypted", async () => {
    await request("/api/platform/profile", {
      headers: { "x-connection-encrypted": "client-supplied" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).not.toHaveProperty("x-connection-encrypted");
  });

  it("redirects an unknown Studio project page to the project list", async () => {
    const response = await request("/project/default/editor");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/projects");
    expect(seen).toHaveLength(0);
  });
});

describe("paths that look like another host", () => {
  it.each(["//evil.example/x", "//meta:8080/health", "/%2F%2Fevil/x", "//_hs/static/studio.css"])(
    "answers %s with 404 and never fetches it",
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(seen).toHaveLength(0);
    },
  );

  it.each(["//evil.example/x?a=1", "//meta:8080/health"])(
    "proxyToStudio sends %s to Studio's origin, not to the host in the path",
    async (path) => {
      seen = [];
      const response = await proxyToStudio(studioUrl, new Request(`http://hattisar.test${path}`));
      expect(response.status).toBe(200);
      expect(seen.map((s) => s.url)).toEqual([path]);
      expect(seen[0]?.headers.host).toBe(new URL(studioUrl).host);
    },
  );
});
