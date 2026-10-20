import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { saveS3Settings } from "../../src/backups/s3-settings.js";
import { loadConfig } from "../../src/config.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { deriveSecretKey } from "../../src/registry/secrets.js";
import { insertUser } from "../../src/registry/users.js";
import { signInToRegistry } from "../helpers/session.js";

const connection = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; problem: string },
}));

vi.mock("../../src/backups/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/s3.js")>()),
  testS3Connection: async () => connection.result,
}));

const ORIGIN = "http://hattisar.test";
const SECRET = "s".repeat(32);
const PASSWORD = "unit-admin-password";
const ACCOUNT_FORM = 'action="/_hs/settings/password"';
const STORAGE_FORM = 'action="/_hs/settings/s3"';

const s3Fields = {
  endpoint: "https://s3.example.test:9000",
  region: "us-east-1",
  bucket: "team-backups",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "a-secret-key",
  prefix: "hattisar",
};

let dataDir: string;
let db: Registry;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-settings-"));
  db = openRegistry(dataDir);
  insertUser(db, { username: "admin", passwordHash: await hashPassword(PASSWORD) });
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: SECRET,
      PG_META_CRYPTO_KEY: "unit-test-crypto-key",
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
      STUDIO_URL: "http://127.0.0.1:9",
    }),
    db,
  );
  cookie = signInToRegistry(db);
  connection.result = { ok: true };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, { headers: { cookie } });
}

async function post(path: string, fields: Record<string, string>): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body: new URLSearchParams(fields),
  });
}

function configureS3(endpoint: string | undefined) {
  saveS3Settings(db, deriveSecretKey(SECRET), {
    ...s3Fields,
    endpoint,
    forcePathStyle: true,
  });
}

function currentSection(html: string): string | undefined {
  return /<a href="([^"]+)" class="settings-nav-link" aria-current="page"/.exec(html)?.[1];
}

describe("settings sections", () => {
  it("redirects /_hs/settings to backup storage", async () => {
    const response = await get("/_hs/settings");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/settings/storage");
  });

  it("renders the account section with its nav item current and the username", async () => {
    const response = await get("/_hs/settings/account");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<nav class="settings-nav" aria-label="Settings sections">');
    expect(currentSection(html)).toBe("/_hs/settings/account");
    expect(html).toContain("Signed in as");
    expect(html).toContain(">admin</strong>");
    expect(html).toContain(ACCOUNT_FORM);
    expect(html).not.toContain(STORAGE_FORM);
  });

  it("renders the storage section with its nav item current", async () => {
    const response = await get("/_hs/settings/storage");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/storage");
    expect(html).toContain(STORAGE_FORM);
    expect(html).not.toContain(ACCOUNT_FORM);
  });
});

describe("storage status", () => {
  it("says storage is not configured", async () => {
    const html = await (await get("/_hs/settings/storage")).text();
    expect(html).toContain("Not configured — backups and restores need this.");
  });

  it("names the bucket and endpoint host once configured", async () => {
    configureS3(s3Fields.endpoint);
    const html = await (await get("/_hs/settings/storage")).text();
    expect(html).toContain("Configured · bucket <code>team-backups</code> on s3.example.test:9000");
    expect(html).not.toContain("Not configured");
  });

  it("leaves the endpoint out for AWS S3", async () => {
    configureS3(undefined);
    const html = await (await get("/_hs/settings/storage")).text();
    expect(html).toContain("Configured · bucket <code>team-backups</code></p>");
  });
});

describe("password POST", () => {
  it("re-renders the account section with the error", async () => {
    const response = await post("/_hs/settings/password", {
      current: "not-the-password",
      password: "a-new-password",
      confirm: "a-new-password",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/account");
    expect(html).toContain("Current password is wrong.");
  });

  it("re-renders the account section once saved", async () => {
    const response = await post("/_hs/settings/password", {
      current: PASSWORD,
      password: "a-new-password",
      confirm: "a-new-password",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/account");
    expect(html).toContain("Password changed. Other sessions were logged out.");
  });
});

describe("S3 POSTs", () => {
  it("re-renders the storage section with the problems", async () => {
    const response = await post("/_hs/settings/s3", { ...s3Fields, bucket: "X" });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/storage");
    expect(html).toContain("Bucket must be 3-63 characters");
    expect(html).toContain("Not configured");
  });

  it("re-renders the storage section once saved, now configured", async () => {
    const response = await post("/_hs/settings/s3", s3Fields);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/storage");
    expect(html).toContain("S3 settings saved.");
    expect(html).toContain("Configured · bucket <code>team-backups</code>");
    expect(html).not.toContain(s3Fields.secretAccessKey);
  });

  it("reports a working connection", async () => {
    const response = await post("/_hs/settings/s3/test", s3Fields);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/storage");
    expect(html).toContain("Connection works");
    expect(html).toContain("Nothing was saved.");
  });

  it("reports a failed connection", async () => {
    connection.result = { ok: false, problem: "Access Denied" };
    const response = await post("/_hs/settings/s3/test", s3Fields);
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(currentSection(html)).toBe("/_hs/settings/storage");
    expect(html).toContain("Connection failed: Access Denied");
  });
});
