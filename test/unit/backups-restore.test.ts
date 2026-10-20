import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreIntoProject } from "../../src/backups/restore.js";
import { saveS3Settings } from "../../src/backups/s3-settings.js";
import type { BackupDeps } from "../../src/backups/service.js";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import type { ProjectServiceDeps } from "../../src/projects/service.js";
import { insertBackup, markBackupDone } from "../../src/registry/backups.js";
import { type Box, getSharedBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject, type Project } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";

const restoreFails = vi.hoisted(() => ({ value: false }));

vi.mock("../../src/backups/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/s3.js")>()),
  downloadBackupObject: async () => {},
}));

vi.mock("../../src/backups/pg-restore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/backups/pg-restore.js")>()),
  writeRestoreList: async () => {},
  restoreArchive: async () => {
    if (restoreFails.value) throw new Error("pg_restore exited with code 1");
  },
}));

const secretKey = deriveSecretKey("r".repeat(32));

let dataDir: string;
let db: Registry;
let box: Box;
let project: Project;
let sql: string[];
let deps: BackupDeps;
let projectDeps: ProjectServiceDeps;

const fakeAdmin: AdminClientRunner = async (_conn, run) => {
  const client = {
    query: async (text: string) => {
      sql.push(text);
      return { rowCount: 0, rows: [] };
    },
  };
  return run(client as unknown as pg.Client);
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-restore-"));
  db = openRegistry(dataDir);
  seedSharedBox(
    db,
    loadConfig({
      HATTISAR_SECRET_KEY: "r".repeat(32),
      PG_META_CRYPTO_KEY: "unit",
      POSTGRES_PASSWORD: "box-admin",
      POOLER_TENANT_ID: "hattisar",
    }),
    secretKey,
  );
  box = getSharedBox(db) as Box;
  saveS3Settings(db, secretKey, {
    endpoint: undefined,
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "id",
    secretAccessKey: "secret",
    forcePathStyle: false,
    prefix: "hattisar",
  });
  project = insertProject(db, {
    ref: "my-app",
    name: "my-app",
    boxId: box.id,
    dbName: "my_app",
    ownerRole: "hs_my_app_owner",
    ownerPasswordEnc: encryptSecret("owner-pw", secretKey),
  });
  sql = [];
  restoreFails.value = false;
  deps = { db, secretKey, pgBinDir: "/unused", dataDir, backupHourUtc: 2 };
  projectDeps = { db, secretKey, admin: fakeAdmin, refreshPooler: async () => {} };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function doneBackup() {
  const backup = insertBackup(db, {
    projectId: project.id,
    kind: "manual",
    bucket: "b",
    s3Key: "hattisar/my-app/x.dump",
  });
  markBackupDone(db, backup.id, 1);
  return { ...backup, status: "done" as const };
}

describe("restoring into the same project", () => {
  it("drops and recreates the database before restoring", async () => {
    expect(await restoreIntoProject(deps, projectDeps, doneBackup(), project, box)).toEqual({
      ok: true,
    });
    expect(sql[0]).toBe('DROP DATABASE IF EXISTS "my_app" WITH (FORCE)');
  });

  it("says the previous data was replaced when pg_restore fails after the drop", async () => {
    restoreFails.value = true;
    expect(await restoreIntoProject(deps, projectDeps, doneBackup(), project, box)).toEqual({
      ok: false,
      problem:
        "The previous data of my-app was replaced and its database now holds part of the backup. Restore again to finish. Restore failed: pg_restore exited with code 1",
    });
  });
});
