import type { BoxConnection } from "../boxes/admin-client.js";
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
import { DumpError, type RunningDump, startDump } from "./pg-dump.js";
import { redact } from "./redact.js";
import { deleteBackupObject, s3ErrorMessage, uploadStream } from "./s3.js";
import { loadS3Settings } from "./s3-settings.js";

export interface BackupDeps {
  db: Registry;
  secretKey: Buffer;
  pgBinDir: string;
  dataDir: string;
  backupHourUtc: number;
}

export type BackupOutcome = { ok: true } | { ok: false; problem: string };

export const NOT_CONFIGURED = "Configure S3 storage in Settings first.";

// Projects whose database a restore is replacing; a backup taken meanwhile would dump a half-restored
// database. In memory only: a restart kills the restore along with it.
const restoring = new Set<number>();

export function isRestoring(projectId: number): boolean {
  return restoring.has(projectId);
}

export async function whileRestoring<T>(projectId: number, run: () => Promise<T>): Promise<T> {
  restoring.add(projectId);
  try {
    return await run();
  } finally {
    restoring.delete(projectId);
  }
}

export function boxCredentials(box: Box, secretKey: Buffer): BoxConnection | string {
  try {
    return boxConnection(box, secretKey);
  } catch {
    return `Could not read the credentials of box ${box.name}.`;
  }
}

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
  if (isRestoring(project.id)) {
    return { ok: false, problem: `${project.ref} is being restored. Try again when it finishes.` };
  }
  const key = backupKey(settings.prefix, project.ref, kind, now);
  if (existing.some((backup) => backup.s3Key === key)) {
    return { ok: false, problem: "A backup was taken this second. Try again in a moment." };
  }
  const conn = boxCredentials(box, deps.secretKey);
  if (typeof conn === "string") return { ok: false, problem: `Backup failed: ${conn}` };
  const backup = insertBackup(
    deps.db,
    { projectId: project.id, kind, bucket: settings.bucket, s3Key: key },
    now.toISOString(),
  );
  let dump: RunningDump | undefined;
  try {
    dump = startDump(deps.pgBinDir, conn, project.dbName);
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
    dump?.stream.destroy();
  }
}

export async function removeBackup(deps: BackupDeps, backup: Backup): Promise<BackupOutcome> {
  if (backup.status === "running") {
    return { ok: false, problem: "A running backup can't be deleted." };
  }
  const settings = loadS3Settings(deps.db, deps.secretKey);
  if (settings !== undefined) {
    try {
      await deleteBackupObject(settings, backup);
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
