import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import { insertBackup, markBackupDone } from "../../src/registry/backups.js";
import { getSharedBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { signInToRegistry } from "../helpers/session.js";

const ORIGIN = "http://hattisar.test";
const SECRET = "s".repeat(32);

let dataDir: string;
let db: Registry;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-backups-app-"));
  db = openRegistry(dataDir);
  const config = loadConfig({
    HATTISAR_SECRET_KEY: SECRET,
    PG_META_CRYPTO_KEY: "unit-test-crypto-key",
    POSTGRES_PASSWORD: "unused",
    POOLER_TENANT_ID: "hattisar",
    POOLER_JWT_SECRET: "pooler-jwt-secret",
    STUDIO_URL: "http://127.0.0.1:9",
  });
  seedSharedBox(db, config, deriveSecretKey(SECRET));
  app = createApp(config, db);
  cookie = signInToRegistry(db);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("restoring a backup in place from the UI", () => {
  it.each([
    ["confirmed", { confirm: "shop" }],
    ["unconfirmed", {}],
  ])("answers 409 for an attached project, %s", async (_, fields) => {
    const project = insertProject(db, {
      ref: "shop",
      name: "Shop",
      boxId: getSharedBox(db)?.id ?? 0,
      dbName: "shop",
      ownerRole: "app",
      ownerPasswordEnc: encryptSecret("app-secret", deriveSecretKey(SECRET)),
      kind: "attached",
    });
    const backup = insertBackup(db, {
      projectId: project.id,
      kind: "manual",
      bucket: "b",
      s3Key: "k",
    });
    markBackupDone(db, backup.id, 7);
    const response = await app.request(`${ORIGIN}/_hs/projects/shop/backups/${backup.id}/restore`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
      body: new URLSearchParams(fields),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("shop is attached; detach it instead.");
  });
});
