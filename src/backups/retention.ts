import type { Backup } from "../registry/backups.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ISO weeks start on Monday, so the Monday's date names the week.
function isoWeek(createdAt: string): string {
  const day = new Date(createdAt);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const monday = midnight - ((day.getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

// §8: of the done scheduled backups keep the newest keepDaily, then the newest of each older ISO
// week up to keepWeekly weeks; everything else goes. Manual backups are never pruned.
export function backupsToPrune(backups: Backup[], keepDaily: number, keepWeekly: number): Backup[] {
  const newestFirst = backups
    .filter((backup) => backup.kind === "scheduled" && backup.status === "done")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  const weeksKept = new Set<string>();
  return newestFirst.slice(keepDaily).filter((backup) => {
    const week = isoWeek(backup.createdAt);
    if (weeksKept.has(week) || weeksKept.size >= keepWeekly) return true;
    weeksKept.add(week);
    return false;
  });
}
