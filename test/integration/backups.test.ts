import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProject,
  dropProject,
  fetchWith,
  postQuery,
  sharedBoxId,
} from "../helpers/projects.js";
import { objectStatus, type S3Test, s3Fields, s3TestService } from "../helpers/s3.js";
import { postForm, signIn } from "../helpers/session.js";
import { compose, registryRows, registrySql, sharedBoxSql, stackEnv } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const ref = `it-bak-${randomUUID().slice(0, 8)}`;
const dbName = ref.replaceAll("-", "_");
let cookie: string;

interface BackupRow {
  id: number;
  kind: string;
  bucket: string | null;
  s3Key: string;
  sizeBytes: number | null;
  status: string;
  error: string | null;
}

let s3: S3Test;

function backups(): BackupRow[] {
  return registryRows<BackupRow>(
    `SELECT b.id, b.kind, b.bucket, b.s3_key AS s3Key, b.size_bytes AS sizeBytes, b.status, b.error
       FROM backups b JOIN projects p ON p.id = b.project_id WHERE p.ref = ? ORDER BY b.id`,
    ref,
  );
}

beforeAll(async () => {
  s3 = s3TestService();
  cookie = await signIn(baseUrl);
  const boxId = await sharedBoxId(baseUrl, cookie);
  const created = await createProject(baseUrl, cookie, { ref, name: ref, boxId });
  if (created.status !== 302) throw new Error(`creating ${ref} failed: ${created.status}`);
  const table = await postQuery(
    baseUrl,
    cookie,
    ref,
    "create table public.widgets (id int primary key); insert into public.widgets values (1), (2)",
  );
  if (table.status !== 200) throw new Error(`creating ${ref}.widgets failed`);
});

afterAll(() => {
  dropProject(ref);
  registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
});

describe("download dump", () => {
  it("streams a custom-format archive named <ref>-<UTC stamp>.dump", async () => {
    const response = await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/dump`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      new RegExp(`^attachment; filename="${ref}-\\d{8}T\\d{6}Z\\.dump"$`),
    );
    const archive = Buffer.from(await response.arrayBuffer());
    expect(archive.subarray(0, 5).toString()).toBe("PGDMP");
    const listing = compose(["exec", "-T", "hattisar", "pg_restore", "-l"], archive);
    expect(listing).toMatch(/TABLE public widgets /);
  });

  it("aborts the response when pg_dump fails after the headers are sent", async () => {
    const blobs = await postQuery(
      baseUrl,
      cookie,
      ref,
      `create table public.blobs as
         select g as id, extensions.gen_random_bytes(1024) as body from generate_series(1, 30000) g`,
    );
    expect(blobs.status).toBe(200);
    const response = await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/dump`);
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    // Unread, the response holds pg_dump mid-table by backpressure, so its backend is still there.
    const terminated = sharedBoxSql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = :'db' AND application_name = 'pg_dump'`,
      { db: dbName },
    );
    expect(terminated.trim()).toBe("t");
    const drain = async () => {
      for (;;) if ((await reader.read()).done) return "complete";
    };
    await expect(drain()).rejects.toThrow();
  });

  it("is not found for an unknown project", async () => {
    const response = await fetchWith(baseUrl, cookie, "/_hs/projects/no-such-ref/dump");
    expect(response.status).toBe(404);
  });
});

describe("S3 settings", () => {
  it("refuses Back up now until S3 is configured", async () => {
    registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
    const page = await (await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/backups`)).text();
    expect(page).toContain("Configure S3 storage in");
    const response = await postForm(baseUrl, `/_hs/projects/${ref}/backups`, {}, cookie);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Configure S3 storage in Settings first.");
  });

  it("tests a working connection without saving it", async () => {
    const response = await postForm(baseUrl, "/_hs/settings/s3/test", s3Fields(s3), cookie);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Connection works");
    expect(html).not.toContain(s3.secretKey);
    expect(objectStatus(s3, "it-backups/.hattisar-test").status).toBe(404);
    expect(registryRows("SELECT key FROM settings WHERE key LIKE 's3.%'")).toEqual([]);
  });

  it("reports bad credentials inline without echoing the secret", async () => {
    const wrong = `wrong-${randomUUID()}`;
    const response = await postForm(
      baseUrl,
      "/_hs/settings/s3/test",
      s3Fields(s3, { secretAccessKey: wrong }),
      cookie,
    );
    const html = await response.text();
    expect(response.status).toBe(502);
    expect(html).toContain("Connection failed:");
    expect(html).not.toContain(wrong);
  });

  it("saves the settings with the secret write-only", async () => {
    const response = await postForm(baseUrl, "/_hs/settings/s3", s3Fields(s3), cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("S3 settings saved.");
    const page = await (await fetchWith(baseUrl, cookie, "/_hs/settings/storage")).text();
    expect(page).toContain(`value="${s3.accessKey}"`);
    expect(page).toContain("Leave blank to keep the saved key.");
    expect(page).not.toContain(s3.secretKey);
    const kept = await postForm(
      baseUrl,
      "/_hs/settings/s3/test",
      s3Fields(s3, { secretAccessKey: "" }),
      cookie,
    );
    expect(await kept.text()).toContain("Connection works");
  });
});

describe("back up now", () => {
  it("uploads the dump and records a done backup", async () => {
    const response = await postForm(baseUrl, `/_hs/projects/${ref}/backups`, {}, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/_hs/projects/${ref}/backups?backed-up`);
    const [backup] = backups();
    expect(backup).toMatchObject({
      kind: "manual",
      bucket: s3.bucket,
      status: "done",
      error: null,
    });
    expect(backup?.s3Key).toMatch(new RegExp(`^it-backups/${ref}/\\d{8}T\\d{6}Z-manual\\.dump$`));
    expect(objectStatus(s3, backup?.s3Key as string)).toEqual({
      status: 200,
      length: backup?.sizeBytes,
    });
    const page = await (await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/backups`)).text();
    expect(page).toContain(`data-backup="${backup?.id}"`);
  });

  it("refuses a second backup while one is running", async () => {
    registrySql(
      `INSERT INTO backups (project_id, kind, s3_key, status, created_at)
       SELECT id, 'manual', 'it-backups/running.dump', 'running', ? FROM projects WHERE ref = ?`,
      new Date().toISOString(),
      ref,
    );
    try {
      const response = await postForm(baseUrl, `/_hs/projects/${ref}/backups`, {}, cookie);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain(`A backup of ${ref} is already running.`);
    } finally {
      registrySql("DELETE FROM backups WHERE s3_key = 'it-backups/running.dump'");
    }
  });

  it("records a failed dump with its error and no plaintext secret", async () => {
    const moved = `${dbName}_moved`;
    sharedBoxSql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'db';
       ALTER DATABASE :"db" RENAME TO :"moved";`,
      { db: dbName, moved },
    );
    try {
      const response = await postForm(baseUrl, `/_hs/projects/${ref}/backups`, {}, cookie);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("Backup failed: pg_dump exited with code 1");
      const download = await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/dump`);
      expect(download.status).toBe(502);
      expect(await download.text()).toContain("Could not dump the database: pg_dump exited");
    } finally {
      sharedBoxSql(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'moved';
         ALTER DATABASE :"moved" RENAME TO :"db";`,
        { db: dbName, moved },
      );
    }
    const failed = backups().at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain(`database "${dbName}" does not exist`);
    const { POSTGRES_PASSWORD } = stackEnv();
    expect(failed?.error).not.toContain(POSTGRES_PASSWORD);
    expect(failed?.error).not.toContain(s3.secretKey);
    expect(objectStatus(s3, failed?.s3Key as string).status).toBe(404);
  });

  it("deletes a backup's object and row", async () => {
    for (const backup of backups()) {
      const response = await postForm(
        baseUrl,
        `/_hs/projects/${ref}/backups/${backup.id}/delete`,
        {},
        cookie,
      );
      expect(response.status).toBe(302);
      expect(objectStatus(s3, backup.s3Key).status).toBe(404);
    }
    expect(backups()).toEqual([]);
  });
});
