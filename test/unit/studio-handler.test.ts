import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import CryptoJS from "crypto-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const cryptoKey = "unit-test-crypto-key";
const spikeB = {
  ref: "spike-b",
  name: "Spike B",
  dbName: "spike_b",
  boxName: "shared",
  box: { host: "db", port: 5432, adminUser: "supabase_admin", adminPassword: "pw" },
};

let studio: Server;
let seen: Seen[] = [];
let app: ReturnType<typeof createApp>;

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
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: "s".repeat(32),
      PG_META_CRYPTO_KEY: cryptoKey,
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      STUDIO_URL: `http://127.0.0.1:${port}`,
      HATTISAR_SPIKE_PROJECTS: JSON.stringify([spikeB]),
    }),
  );
});

afterAll(() => {
  studio.close();
});

function request(path: string, init?: RequestInit): Promise<Response> {
  seen = [];
  return Promise.resolve(app.request(`http://hattisar.test${path}`, init));
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
      "postgresql://supabase_admin:pw@db:5432/spike_b",
    );
    expect(seen[0]?.url).toBe("/api/platform/pg-meta/spike-b/tables?included_schemas=public");
  });

  it("answers an unknown ref with 404 and never reaches Studio", async () => {
    const response = await request("/api/platform/pg-meta/nope/tables");
    expect(response.status).toBe(404);
    expect(seen).toHaveLength(0);
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

  it("redirects an unknown Studio project page to the project list", async () => {
    const response = await request("/project/default/editor");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/projects");
    expect(seen).toHaveLength(0);
  });
});
