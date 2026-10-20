import { describe, expect, it } from "vitest";
import { backupsToPrune } from "../../src/backups/retention.js";
import type { Backup } from "../../src/registry/backups.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// A Tuesday.
const NEWEST = Date.parse("2026-10-20T02:00:00.000Z");

function backup(id: number, createdAt: number, overrides: Partial<Backup> = {}): Backup {
  const iso = new Date(createdAt).toISOString();
  return {
    id,
    projectId: 1,
    kind: "scheduled",
    bucket: "b",
    s3Key: `k${id}`,
    sizeBytes: 1,
    status: "done",
    error: null,
    createdAt: iso,
    finishedAt: iso,
    ...overrides,
  };
}

// id 1 is the newest; one per day going back.
function daily(count: number): Backup[] {
  return Array.from({ length: count }, (_, index) => backup(index + 1, NEWEST - index * DAY_MS));
}

function keptIds(backups: Backup[], keepDaily: number, keepWeekly: number): number[] {
  const pruned = new Set(backupsToPrune(backups, keepDaily, keepWeekly).map((b) => b.id));
  return backups.filter((b) => !pruned.has(b.id)).map((b) => b.id);
}

describe("backupsToPrune", () => {
  it("30 daily backups keep exactly the 7 newest and the newest of 4 older ISO weeks", () => {
    // Newest 7: Oct 20 back to Oct 14 (ids 1-7). The rest start Tue Oct 13 (id 8): its week
    // (Mon Oct 12) keeps id 8, then Sun Oct 11 (id 10), Sun Oct 4 (id 17), Sun Sep 27 (id 24).
    expect(keptIds(daily(30), 7, 4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 17, 24]);
  });

  it.each([
    ["fewer than keep_daily", 5, 7, 4, [1, 2, 3, 4, 5]],
    ["keep_weekly 0", 10, 7, 0, [1, 2, 3, 4, 5, 6, 7]],
    ["keep_daily 1", 15, 1, 2, [1, 2, 3]],
  ] as const)("%s", (_label, count, keepDaily, keepWeekly, kept) => {
    expect(keptIds(daily(count), keepDaily, keepWeekly)).toEqual(kept);
  });

  it("ignores manual, running and failed backups", () => {
    const backups = [
      ...daily(9),
      backup(100, NEWEST - 40 * DAY_MS, { kind: "manual" }),
      backup(101, NEWEST - 41 * DAY_MS, { status: "failed" }),
      backup(102, NEWEST - 42 * DAY_MS, { status: "running" }),
    ];
    expect(backupsToPrune(backups, 1, 0).map((b) => b.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("orders by time, not by list position", () => {
    const shuffled = daily(10).reverse();
    expect(keptIds(shuffled, 3, 0).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
