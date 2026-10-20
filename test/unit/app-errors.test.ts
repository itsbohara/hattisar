import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { signInToRegistry } from "../helpers/session.js";

const SECRET = "plaintext-that-must-not-be-logged";
let dataDir: string;
let registry: Registry;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-errors-"));
  registry = openRegistry(dataDir);
  cookie = signInToRegistry(registry);
  // Encrypted under another key, as after HATTISAR_SECRET_KEY changes: decrypting throws.
  const foreignKey = deriveSecretKey("x".repeat(32));
  const box = insertBox(registry, {
    name: "shared",
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: encryptSecret(SECRET, foreignKey),
    sslmode: "disable",
    publicHost: "localhost",
    publicPort: 54322,
    poolerTenant: "hattisar",
    poolerSessionPort: 54322,
    poolerTransactionPort: 6543,
    containerName: null,
  });
  insertProject(registry, {
    ref: "my-app",
    name: "My App",
    boxId: box.id,
    dbName: "my_app",
    ownerRole: "hs_my_app_owner",
    ownerPasswordEnc: encryptSecret(SECRET, foreignKey),
  });
  app = createApp(
    loadConfig({
      HATTISAR_SECRET_KEY: "s".repeat(32),
      PG_META_CRYPTO_KEY: "unit",
      POSTGRES_PASSWORD: "unused",
      POOLER_TENANT_ID: "hattisar",
    }),
    registry,
  );
});

afterAll(() => {
  registry.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ response: Response; logged: string }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await app.request(path, { headers: { cookie } });
    return { response, logged: spy.mock.calls.flat().join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("unexpected errors", () => {
  it("answers an API path with a JSON 500", async () => {
    const { response, logged } = await get("/api/platform/projects");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "Internal error" } });
    expect(logged).toContain("hattisar: SecretError on GET /api/platform/projects");
  });

  it("renders a page path inline without a stack trace", async () => {
    const { response, logged } = await get("/_hs/projects/my-app");
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Something went wrong");
    expect(html).not.toMatch(/\bat \S+ \(/);
    expect(logged).toContain("SecretError on GET /_hs/projects/my-app");
    expect(logged).not.toContain("could not be decrypted");
    expect(logged).not.toContain(SECRET);
  });
});
