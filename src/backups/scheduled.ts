import {
  type BackupSchedule,
  deleteBackup,
  listBackups,
  listEnabledBackupSchedules,
} from "../registry/backups.js";
import { getBoxById } from "../registry/boxes.js";
import { getProjectById, type Project } from "../registry/projects.js";
import { backupsToPrune } from "./retention.js";
import { deleteBackupObject, s3ErrorMessage } from "./s3.js";
import { isS3Configured, loadS3Settings } from "./s3-settings.js";
import { isBackupDue } from "./schedule.js";
import { type BackupDeps, runBackup } from "./service.js";

// A failed S3 delete keeps the row, so the next retention pass tries that backup again.
export async function applyRetention(
  deps: BackupDeps,
  project: Project,
  schedule: BackupSchedule,
): Promise<void> {
  const settings = loadS3Settings(deps.db, deps.secretKey);
  if (settings === undefined) return;
  const backups = listBackups(deps.db, project.id);
  for (const backup of backupsToPrune(backups, schedule.keepDaily, schedule.keepWeekly)) {
    try {
      await deleteBackupObject(settings, backup);
      deleteBackup(deps.db, backup.id);
    } catch (error) {
      console.error(
        `hattisar: retention could not delete ${backup.s3Key} of ${project.ref}: ${s3ErrorMessage(error, settings)}`,
      );
    }
  }
}

async function runScheduled(
  deps: BackupDeps,
  project: Project,
  schedule: BackupSchedule,
  now: Date,
): Promise<void> {
  const box = getBoxById(deps.db, project.boxId);
  if (box === undefined) return;
  const result = await runBackup(deps, project, box, "scheduled", now);
  if (!result.ok) {
    console.error(`hattisar: scheduled backup of ${project.ref} failed: ${result.problem}`);
    return;
  }
  await applyRetention(deps, project, schedule);
}

// One project's failure never stops the rest. An unexpected throw is logged by class only: its
// message may carry a box credential.
export async function runScheduledBackups(deps: BackupDeps, now: Date): Promise<void> {
  const due = listEnabledBackupSchedules(deps.db).flatMap((schedule) => {
    const project = getProjectById(deps.db, schedule.projectId);
    if (project?.status !== "active") return [];
    const backups = listBackups(deps.db, project.id);
    return isBackupDue(schedule, deps.backupHourUtc, now, backups) ? [{ project, schedule }] : [];
  });
  if (due.length === 0) return;
  if (!isS3Configured(deps.db)) {
    console.warn(`hattisar: ${due.length} scheduled backup(s) due, but S3 is not configured`);
    return;
  }
  for (const { project, schedule } of due) {
    try {
      await runScheduled(deps, project, schedule, now);
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown error";
      console.error(`hattisar: scheduled backup of ${project.ref} failed: ${name}`);
    }
  }
}
