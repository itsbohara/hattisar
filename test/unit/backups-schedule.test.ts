import { describe, expect, it } from "vitest";
import { isBackupDue, periodStart } from "../../src/backups/schedule.js";
import type { Backup, BackupSchedule } from "../../src/registry/backups.js";

const HOUR = 2;

function schedule(frequency: BackupSchedule["frequency"]): BackupSchedule {
  return { projectId: 1, frequency, keepDaily: 7, keepWeekly: 4 };
}

let nextId = 1;
function backup(createdAt: string, overrides: Partial<Backup> = {}): Backup {
  return {
    id: nextId++,
    projectId: 1,
    kind: "scheduled",
    bucket: "b",
    s3Key: `k${nextId}`,
    sizeBytes: 1,
    status: "done",
    error: null,
    createdAt,
    finishedAt: createdAt,
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe("periodStart", () => {
  it.each([
    ["daily after the hour", "daily", "2026-10-20T02:00:00.000Z", "2026-10-20T02:00:00.000Z"],
    ["daily before the hour", "daily", "2026-10-20T01:59:59.999Z", "2026-10-19T02:00:00.000Z"],
    ["daily across a month end", "daily", "2026-11-01T00:30:00.000Z", "2026-10-31T02:00:00.000Z"],
    [
      "weekly on Monday after the hour",
      "weekly",
      "2026-10-19T02:00:00.000Z",
      "2026-10-19T02:00:00.000Z",
    ],
    [
      "weekly on Monday before the hour",
      "weekly",
      "2026-10-19T01:00:00.000Z",
      "2026-10-12T02:00:00.000Z",
    ],
    ["weekly on Sunday", "weekly", "2026-10-25T23:00:00.000Z", "2026-10-19T02:00:00.000Z"],
    ["weekly across a year end", "weekly", "2027-01-01T12:00:00.000Z", "2026-12-28T02:00:00.000Z"],
  ] as const)("%s", (_label, frequency, now, start) => {
    expect(periodStart(frequency, HOUR, at(now)).toISOString()).toBe(start);
  });
});

describe("isBackupDue", () => {
  it("is never due when off", () => {
    expect(isBackupDue(schedule("off"), HOUR, at("2026-10-20T03:00:00Z"), [])).toBe(false);
  });

  it("is due with no scheduled backup in the current period", () => {
    const yesterday = backup("2026-10-19T02:00:05.000Z");
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-20T02:00:00Z"), [yesterday])).toBe(
      true,
    );
  });

  it("is not due once the period has a done scheduled backup", () => {
    const today = backup("2026-10-20T02:00:05.000Z");
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-21T01:59:00Z"), [today])).toBe(false);
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-21T02:00:00Z"), [today])).toBe(true);
  });

  it("does not count manual backups", () => {
    const manual = backup("2026-10-20T03:00:00.000Z", { kind: "manual" });
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-20T04:00:00Z"), [manual])).toBe(true);
  });

  it("weekly: one done backup covers Monday to the next Monday", () => {
    const monday = backup("2026-10-19T02:00:05.000Z");
    expect(isBackupDue(schedule("weekly"), HOUR, at("2026-10-25T23:59:00Z"), [monday])).toBe(false);
    expect(isBackupDue(schedule("weekly"), HOUR, at("2026-10-26T02:00:00Z"), [monday])).toBe(true);
  });

  it("is not due while a backup of the project is running", () => {
    const running = backup("2026-10-20T02:00:05.000Z", { kind: "manual", status: "running" });
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-20T02:01:00Z"), [running])).toBe(false);
  });

  it("retries a failed scheduled backup an hour after it failed", () => {
    const failed = backup("2026-10-20T02:00:05.000Z", {
      status: "failed",
      finishedAt: "2026-10-20T02:00:10.000Z",
    });
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-20T03:00:09Z"), [failed])).toBe(false);
    expect(isBackupDue(schedule("daily"), HOUR, at("2026-10-20T03:00:10Z"), [failed])).toBe(true);
  });
});
