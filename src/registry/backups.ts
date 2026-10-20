import type { Registry } from "./db.js";

export type BackupFrequency = "off" | "daily" | "weekly";
export type BackupKind = "manual" | "scheduled";
export type BackupStatus = "running" | "done" | "failed";

export interface BackupSchedule {
  projectId: number;
  frequency: BackupFrequency;
  keepDaily: number;
  keepWeekly: number;
}

export interface Backup {
  id: number;
  projectId: number;
  kind: BackupKind;
  s3Key: string;
  sizeBytes: number | null;
  status: BackupStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const SCHEDULE_COLUMNS =
  "project_id AS projectId, frequency, keep_daily AS keepDaily, keep_weekly AS keepWeekly";

const BACKUP_COLUMNS = `id, project_id AS projectId, kind, s3_key AS s3Key, size_bytes AS sizeBytes,
  status, error, created_at AS createdAt, finished_at AS finishedAt`;

export function defaultBackupSchedule(projectId: number): BackupSchedule {
  return { projectId, frequency: "off", keepDaily: 7, keepWeekly: 4 };
}

export function getBackupSchedule(db: Registry, projectId: number): BackupSchedule {
  return (
    db
      .prepare<[number], BackupSchedule>(
        `SELECT ${SCHEDULE_COLUMNS} FROM backup_schedules WHERE project_id = ?`,
      )
      .get(projectId) ?? defaultBackupSchedule(projectId)
  );
}

export function setBackupSchedule(db: Registry, schedule: BackupSchedule): void {
  db.prepare<[BackupSchedule]>(
    `INSERT INTO backup_schedules (project_id, frequency, keep_daily, keep_weekly)
     VALUES (@projectId, @frequency, @keepDaily, @keepWeekly)
     ON CONFLICT (project_id) DO UPDATE SET frequency = excluded.frequency,
       keep_daily = excluded.keep_daily, keep_weekly = excluded.keep_weekly`,
  ).run(schedule);
}

export function listEnabledBackupSchedules(db: Registry): BackupSchedule[] {
  return db
    .prepare<[], BackupSchedule>(
      `SELECT ${SCHEDULE_COLUMNS} FROM backup_schedules WHERE frequency <> 'off'`,
    )
    .all();
}

export function insertBackup(
  db: Registry,
  backup: { projectId: number; kind: BackupKind; s3Key: string },
  now: string = new Date().toISOString(),
): Backup {
  return db
    .prepare<[number, BackupKind, string, string], Backup>(
      `INSERT INTO backups (project_id, kind, s3_key, status, created_at)
       VALUES (?, ?, ?, 'running', ?)
       RETURNING ${BACKUP_COLUMNS}`,
    )
    .get(backup.projectId, backup.kind, backup.s3Key, now) as Backup;
}

export function getBackup(db: Registry, id: number): Backup | undefined {
  return db.prepare<[number], Backup>(`SELECT ${BACKUP_COLUMNS} FROM backups WHERE id = ?`).get(id);
}

// Newest first.
export function listBackups(db: Registry, projectId: number): Backup[] {
  return db
    .prepare<[number], Backup>(
      `SELECT ${BACKUP_COLUMNS} FROM backups WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(projectId);
}

export function markBackupDone(
  db: Registry,
  id: number,
  sizeBytes: number,
  now: string = new Date().toISOString(),
): void {
  db.prepare<[number, string, number]>(
    "UPDATE backups SET status = 'done', size_bytes = ?, finished_at = ? WHERE id = ?",
  ).run(sizeBytes, now, id);
}

export function markBackupFailed(
  db: Registry,
  id: number,
  error: string,
  now: string = new Date().toISOString(),
): void {
  db.prepare<[string, string, number]>(
    "UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
  ).run(error, now, id);
}

export function deleteBackup(db: Registry, id: number): void {
  db.prepare<[number]>("DELETE FROM backups WHERE id = ?").run(id);
}
