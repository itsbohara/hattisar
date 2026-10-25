import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeStaleRestoreDirs, restoreIntoProject } from "../../src/backups/restore.js";
import { saveS3Settings } from "../../src/backups/s3-settings.js";
import { type BackupDeps, runBackup } from "../../src/backups/service.js";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import { softDeleteProject } from "../../src/projects/lifecycle.js";
import { busyReason, holdingProject } from "../../src/projects/locks.js";
import type { ProjectServiceDeps } from "../../src/projects/service.js";
import { insertBackup, markBackupDone } from "../../src/registry/backups.js";
import { type Box, getSharedBox } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject, type Project } from "../../src/registry/projects.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";
import { countedAdmin, gatedAdmin } from "../helpers/gate.js";

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
      POOLER_JWT_SECRET: "pooler-jwt-secret",
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
  projectDeps = {
    db,
    secretKey,
    admin: fakeAdmin,
    refreshPooler: async () => {},
    poolerHost: "localhost",
  };
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
  it("refuses an attached project before reading anything", async () => {
    const attachedProject = { ...project, kind: "attached" as const };
    expect(await restoreIntoProject(deps, projectDeps, doneBackup(), attachedProject, box)).toEqual(
      { ok: false, problem: "my-app is attached; detach it instead." },
    );
    expect(sql).toEqual([]);
  });

  it("drops and recreates the database before restoring", async () => {
    expect(await restoreIntoProject(deps, projectDeps, doneBackup(), project, box)).toEqual({
      ok: true,
    });
    expect(sql[0]).toBe('DROP DATABASE IF EXISTS "my_app" WITH (FORCE)');
    expect(sql[1]).toBe('CREATE DATABASE "my_app" OWNER "hs_my_app_owner"');
  });

  it("grants the owner role to a non-superuser admin before recreating the database", async () => {
    const plain = { ...box, adminSuperuser: false };
    expect(await restoreIntoProject(deps, projectDeps, doneBackup(), project, plain)).toEqual({
      ok: true,
    });
    expect(sql.slice(1, 3)).toEqual([
      `GRANT "hs_my_app_owner" TO CURRENT_USER`,
      'CREATE DATABASE "my_app" OWNER "hs_my_app_owner"',
    ]);
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

describe("restoring alongside other lifecycle operations", () => {
  it("refuses a restore while a delete is on the box, and after it lands", async () => {
    const gate = gatedAdmin(fakeAdmin);
    const deleting = softDeleteProject({ ...projectDeps, admin: gate.admin }, project, box);
    await gate.entered;

    const { admin, calls } = countedAdmin(fakeAdmin);
    const restoring = { ...projectDeps, admin };
    expect(await restoreIntoProject(deps, restoring, doneBackup(), project, box)).toEqual({
      ok: false,
      problem:
        "Can't restore a backup into my-app while it is being deleted. Try again when it finishes.",
    });
    expect(calls()).toBe(0);

    gate.release();
    expect(await deleting).toEqual({ ok: true });
    expect(busyReason(db, project)).toBeUndefined();
    expect(await restoreIntoProject(deps, restoring, doneBackup(), project, box)).toEqual({
      ok: false,
      problem: "Can't restore a backup into my-app: it is deleted now.",
    });
    expect(calls()).toBe(0);
  });

  it("refuses a delete while a restore is on the box, then allows it", async () => {
    const gate = gatedAdmin(fakeAdmin);
    const restoring = restoreIntoProject(
      deps,
      { ...projectDeps, admin: gate.admin },
      doneBackup(),
      project,
      box,
    );
    await gate.entered;

    const { admin, calls } = countedAdmin(fakeAdmin);
    expect(await softDeleteProject({ ...projectDeps, admin }, project, box)).toEqual({
      ok: false,
      problem: "Can't delete my-app while it is being restored. Try again when it finishes.",
    });
    expect(calls()).toBe(0);

    gate.release();
    expect(await restoring).toEqual({ ok: true });
    expect(await softDeleteProject({ ...projectDeps, admin }, project, box)).toEqual({ ok: true });
  });

  it("frees the project when a restore fails", async () => {
    restoreFails.value = true;
    expect((await restoreIntoProject(deps, projectDeps, doneBackup(), project, box)).ok).toBe(
      false,
    );
    expect(busyReason(db, project)).toBeUndefined();
  });

  it("refuses a manual backup while an operation holds the project", async () => {
    const operation = { action: "delete", holds: "it is being deleted", status: "active" } as const;
    await holdingProject(db, project, operation, async () => {
      expect(await runBackup(deps, project, box, "manual")).toEqual({
        ok: false,
        problem: "Can't back up my-app while it is being deleted. Try again when it finishes.",
      });
    });
  });
});

describe("removeStaleRestoreDirs", () => {
  it("removes leftover restore directories and nothing else", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hattisar-stale-"));
    try {
      mkdirSync(join(dataDir, "restore-a"));
      writeFileSync(join(dataDir, "restore-a", "backup.dump"), "x");
      mkdirSync(join(dataDir, "restore-b"));
      mkdirSync(join(dataDir, "other"));
      writeFileSync(join(dataDir, "registry.db"), "x");
      writeFileSync(join(dataDir, "restore-note"), "x");

      await removeStaleRestoreDirs(dataDir);

      expect(readdirSync(dataDir).sort()).toEqual(["other", "registry.db", "restore-note"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("warns and does not throw when the data directory cannot be listed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        removeStaleRestoreDirs(join(tmpdir(), "hattisar-missing-dir")),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
