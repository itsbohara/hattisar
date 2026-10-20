import type { Backup, BackupFrequency, BackupSchedule } from "../registry/backups.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Without a pause, a backup that keeps failing would be retried, and leave a failed row, every
// minute until the period ends.
export const RETRY_AFTER_FAILURE_MS = HOUR_MS;

// The most recent start of a period at or before now: daily at hourUtc, weekly on Monday at hourUtc.
export function periodStart(
  frequency: Exclude<BackupFrequency, "off">,
  hourUtc: number,
  now: Date,
): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  const daysSinceMonday = frequency === "weekly" ? (now.getUTCDay() + 6) % 7 : 0;
  const length = frequency === "weekly" ? 7 * DAY_MS : DAY_MS;
  const start = today - daysSinceMonday * DAY_MS;
  return new Date(start > now.getTime() ? start - length : start);
}

export function isBackupDue(
  schedule: BackupSchedule,
  hourUtc: number,
  now: Date,
  backups: Backup[],
): boolean {
  if (schedule.frequency === "off") return false;
  if (backups.some((backup) => backup.status === "running")) return false;
  const start = periodStart(schedule.frequency, hourUtc, now).getTime();
  const inPeriod = backups.filter(
    (backup) => backup.kind === "scheduled" && Date.parse(backup.createdAt) >= start,
  );
  if (inPeriod.some((backup) => backup.status === "done")) return false;
  const lastFailure = Math.max(
    ...inPeriod.map((backup) => Date.parse(backup.finishedAt ?? backup.createdAt)),
  );
  return now.getTime() - lastFailure >= RETRY_AFTER_FAILURE_MS;
}
