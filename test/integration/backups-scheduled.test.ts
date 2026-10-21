import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, dropProject, fetchWith, sharedBoxId } from "../helpers/projects.js";
import { objectStatus, type S3Test, s3Fields, s3TestService } from "../helpers/s3.js";
import { postForm, signIn } from "../helpers/session.js";
import { registryRows, registrySql } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const ref = `it-sched-${randomUUID().slice(0, 8)}`;
const DAY_MS = 24 * 60 * 60 * 1000;
// The scheduler ticks once a minute.
const TICK_WAIT_MS = 90_000;
let cookie: string;
let s3: S3Test;

interface BackupRow {
  id: number;
  kind: string;
  status: string;
  s3Key: string;
}

function backups(): BackupRow[] {
  return registryRows<BackupRow>(
    `SELECT b.id, b.kind, b.status, b.s3_key AS s3Key FROM backups b
       JOIN projects p ON p.id = b.project_id WHERE p.ref = ? ORDER BY b.id`,
    ref,
  );
}

async function waitFor<T>(find: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

beforeAll(async () => {
  s3 = s3TestService();
  cookie = await signIn(baseUrl);
  const boxId = await sharedBoxId(baseUrl, cookie);
  const saved = await postForm(baseUrl, "/_hs/settings/s3", s3Fields(s3), cookie);
  if (saved.status !== 200) throw new Error(`saving S3 settings failed: ${saved.status}`);
  const created = await createProject(baseUrl, cookie, { ref, name: ref, boxId });
  if (created.status !== 302) throw new Error(`creating ${ref} failed: ${created.status}`);
});

afterAll(() => {
  dropProject(ref);
  registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
});

describe("backup schedule", () => {
  it("rejects a keep_daily of 0", async () => {
    const response = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/schedule`,
      { frequency: "daily", keepDaily: "0", keepWeekly: "4" },
      cookie,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Keep daily must be a whole number from 1 to 1000.");
  });

  it(
    "runs a due daily backup on the next tick, then prunes older scheduled backups",
    async () => {
      for (const daysAgo of [10, 20, 30]) {
        const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
        registrySql(
          `INSERT INTO backups (project_id, kind, bucket, s3_key, size_bytes, status, created_at, finished_at)
           SELECT id, 'scheduled', ?, ?, 1, 'done', ?, ? FROM projects WHERE ref = ?`,
          s3.bucket,
          `it-backups/${ref}/old-${daysAgo}.dump`,
          at,
          at,
          ref,
        );
      }
      const manual = new Date(Date.now() - 40 * DAY_MS).toISOString();
      registrySql(
        `INSERT INTO backups (project_id, kind, bucket, s3_key, size_bytes, status, created_at, finished_at)
         SELECT id, 'manual', ?, ?, 1, 'done', ?, ? FROM projects WHERE ref = ?`,
        s3.bucket,
        `it-backups/${ref}/old-manual.dump`,
        manual,
        manual,
        ref,
      );

      const saved = await postForm(
        baseUrl,
        `/_hs/projects/${ref}/schedule`,
        { frequency: "daily", keepDaily: "1", keepWeekly: "0" },
        cookie,
      );
      expect(saved.status).toBe(302);
      expect(saved.headers.get("location")).toBe(`/_hs/projects/${ref}/backups?schedule-saved`);
      const page = await (await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/backups`)).text();
      expect(page).toMatch(/<option value="daily" selected="">daily<\/option>/);

      const taken = await waitFor(
        () =>
          backups().find(
            (backup) =>
              backup.kind === "scheduled" &&
              backup.status === "done" &&
              backup.s3Key.endsWith("-scheduled.dump"),
          ),
        TICK_WAIT_MS,
      );
      expect(objectStatus(s3, taken.s3Key).status).toBe(200);
      const remaining = await waitFor(() => {
        const rows = backups();
        return rows.some((row) => row.s3Key.includes("/old-") && row.kind === "scheduled")
          ? undefined
          : rows;
      }, 10_000);
      expect(remaining.map((row) => row.s3Key)).toEqual([
        `it-backups/${ref}/old-manual.dump`,
        taken.s3Key,
      ]);
    },
    TICK_WAIT_MS + 30_000,
  );
});
