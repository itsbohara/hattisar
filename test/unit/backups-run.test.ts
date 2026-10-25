import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveS3Settings } from "../../src/backups/s3-settings.js";
import { type BackupDeps, runBackup } from "../../src/backups/service.js";
import type { BoxConnection } from "../../src/boxes/admin-client.js";
import { type Box, insertBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject, type Project } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";

const started = vi.hoisted(() => ({ conns: [] as BoxConnection[] }));

vi.mock("../../src/backups/pg-dump.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/pg-dump.js")>()),
  startDump: (_dir: string, conn: BoxConnection) => {
    started.conns.push(conn);
    return { stream: Readable.from(["x"]), bytes: () => 1, exited: Promise.resolve() };
  },
}));

vi.mock("../../src/backups/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/s3.js")>()),
  uploadStream: async () => {},
}));

const secretKey = deriveSecretKey("b".repeat(32));

let dataDir: string;
let db: Registry;
let box: Box;
let deps: BackupDeps;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-run-"));
  db = openRegistry(dataDir);
  box = insertBox(db, {
    name: "rds",
    kind: "registered",
    devOnly: false,
    host: "pg.internal",
    port: 5433,
    adminUser: "rdsadmin",
    adminPasswordEnc: encryptSecret("admin-pw", secretKey),
    sslmode: "require",
    publicHost: "pg.example.test",
    publicPort: 5433,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
    adminSuperuser: false,
  });
  saveS3Settings(db, secretKey, {
    endpoint: undefined,
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "id",
    secretAccessKey: "secret",
    forcePathStyle: false,
    prefix: "hattisar",
  });
  deps = { db, secretKey, pgBinDir: "/unused", dataDir, backupHourUtc: 2 };
  started.conns = [];
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function attached(passwordKey = secretKey): Project {
  return insertProject(db, {
    ref: "shop",
    name: "Shop",
    boxId: box.id,
    dbName: "shop",
    ownerRole: "shop_app",
    ownerPasswordEnc: encryptSecret("login-pw", passwordKey),
    kind: "attached",
    loginSuperuser: false,
  });
}

describe("runBackup of an attached project", () => {
  it("dumps as the login, not the box admin", async () => {
    expect((await runBackup(deps, attached(), box, "manual")).ok).toBe(true);

    expect(started.conns).toMatchObject([
      { host: "pg.internal", port: 5433, user: "shop_app", password: "login-pw" },
    ]);
  });

  it("reports an unreadable login without starting a dump", async () => {
    const project = attached(deriveSecretKey("x".repeat(32)));

    expect(await runBackup(deps, project, box, "manual")).toEqual({
      ok: false,
      problem: "Backup failed: Could not read the login of project shop.",
    });
    expect(started.conns).toEqual([]);
  });
});
