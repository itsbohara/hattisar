import type { BoxConnection } from "../boxes/admin-client.js";
import { boxConnection } from "../boxes/service.js";
import { attachedConnection, isAttached } from "../projects/attach.js";
import { busyProblem } from "../projects/locks.js";
import {
  type Backup,
  type BackupKind,
  deleteBackup,
  failRunningBackups,
  getBackup,
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
export type BackupRun = { ok: true; backup: Backup } | { ok: false; problem: string };

export const NOT_CONFIGURED = "Configure S3 storage in Settings first.";

export function boxCredentials(box: Box, secretKey: Buffer): BoxConnection | string {
  try {
    return boxConnection(box, secretKey);
  } catch {
    return `Could not read the credentials of box ${box.name}.`;
  }
}

// An attached project is dumped as its own login: hattisar never reaches into it as the box admin.
export function dumpConnection(
  project: Project,
  box: Box,
  secretKey: Buffer,
): BoxConnection | string {
  if (!isAttached(project)) return boxCredentials(box, secretKey);
  try {
    return attachedConnection(project, box, secretKey);
  } catch {
    return `Could not read the login of project ${project.ref}.`;
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
): Promise<BackupRun> {
  const settings = loadS3Settings(deps.db, deps.secretKey);
  if (settings === undefined) return { ok: false, problem: NOT_CONFIGURED };
  const existing = listBackups(deps.db, project.id);
  if (existing.some((backup) => backup.status === "running")) {
    return { ok: false, problem: `A backup of ${project.ref} is already running.` };
  }
  const busy = busyProblem(deps.db, project, "back up");
  if (busy !== undefined) return { ok: false, problem: busy };
  const key = backupKey(settings.prefix, project.ref, kind, now);
  if (existing.some((backup) => backup.s3Key === key)) {
    return { ok: false, problem: "A backup was taken this second. Try again in a moment." };
  }
  const conn = dumpConnection(project, box, deps.secretKey);
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
  const done = getBackup(deps.db, backup.id);
  if (done === undefined) throw new Error(`Backup ${backup.id} is not readable after it finished`);
  return { ok: true, backup: done };
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
