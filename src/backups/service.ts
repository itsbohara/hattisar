import { boxConnection } from "../boxes/service.js";
import {
  type Backup,
  type BackupKind,
  deleteBackup,
  failRunningBackups,
  insertBackup,
  listBackups,
  markBackupDone,
  markBackupFailed,
} from "../registry/backups.js";
import type { Box } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import type { Project } from "../registry/projects.js";
import { backupKey } from "./naming.js";
import { DumpError, startDump } from "./pg-dump.js";
import { redact } from "./redact.js";
import { deleteObject, s3ErrorMessage, uploadStream } from "./s3.js";
import { loadS3Settings } from "./s3-settings.js";

export interface BackupDeps {
  db: Registry;
  secretKey: Buffer;
  pgBinDir: string;
}

export type BackupOutcome = { ok: true } | { ok: false; problem: string };

const NOT_CONFIGURED = "Configure S3 storage in Settings first.";

// Nothing survives a restart mid-backup: the pg_dump child and the multipart upload die with it.
export function failInterruptedBackups(db: Registry): void {
  const count = failRunningBackups(db, "interrupted by restart");
  if (count > 0) console.warn(`hattisar: marked ${count} interrupted backup(s) as failed`);
}

// One backup at a time per project: the running check and the insert are synchronous, so no other
// request can slip between them.
export async function runBackup(
  deps: BackupDeps,
  project: Project,
  box: Box,
  kind: BackupKind,
  now: Date = new Date(),
): Promise<BackupOutcome> {
  const settings = loadS3Settings(deps.db, deps.secretKey);
  if (settings === undefined) return { ok: false, problem: NOT_CONFIGURED };
  const existing = listBackups(deps.db, project.id);
  if (existing.some((backup) => backup.status === "running")) {
    return { ok: false, problem: `A backup of ${project.ref} is already running.` };
  }
  const key = backupKey(settings.prefix, project.ref, kind, now);
  if (existing.some((backup) => backup.s3Key === key)) {
    return { ok: false, problem: "A backup was taken this second. Try again in a moment." };
  }
  const backup = insertBackup(
    deps.db,
    { projectId: project.id, kind, s3Key: key },
    now.toISOString(),
  );
  const conn = boxConnection(box, deps.secretKey);
  const dump = startDump(deps.pgBinDir, conn, project.dbName);
  try {
    await uploadStream(settings, key, dump.stream);
    markBackupDone(deps.db, backup.id, dump.bytes());
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof DumpError
        ? error.message
        : redact(s3ErrorMessage(error, settings), [conn.password]);
    markBackupFailed(deps.db, backup.id, message);
    return { ok: false, problem: `Backup failed: ${message}` };
  } finally {
    dump.stream.destroy();
  }
}

export async function removeBackup(deps: BackupDeps, backup: Backup): Promise<BackupOutcome> {
  if (backup.status === "running") {
    return { ok: false, problem: "A running backup can't be deleted." };
  }
  const settings = loadS3Settings(deps.db, deps.secretKey);
  if (settings !== undefined) {
    try {
      await deleteObject(settings, backup.s3Key);
    } catch (error) {
      return {
        ok: false,
        problem: `Could not delete ${backup.s3Key} from S3: ${s3ErrorMessage(error, settings)}`,
      };
    }
  } else if (backup.status === "done") {
    return { ok: false, problem: NOT_CONFIGURED };
  }
  deleteBackup(deps.db, backup.id);
  return { ok: true };
}
