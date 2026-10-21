import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionStrings,
  createProject,
  dropProject,
  fetchWith,
  postQuery,
  sharedBoxId,
} from "../helpers/projects.js";
import {
  deleteObject,
  objectStatus,
  putObject,
  type S3Test,
  s3Fields,
  s3TestService,
} from "../helpers/s3.js";
import { postForm, signIn } from "../helpers/session.js";
import { registryRows, registrySql, sharedBoxSql } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const suffix = randomUUID().slice(0, 8);
const ref = `it-rst-${suffix}`;
const copyRef = `it-rst-copy-${suffix}`;
const brokenRef = `it-rst-broken-${suffix}`;
const ownerRole = `hs_${ref.replaceAll("-", "_")}_owner`;
let cookie: string;
let s3: S3Test;
let boxId: string;

interface BackupRow {
  id: number;
  bucket: string;
  s3Key: string;
}

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function sessionString(projectRef: string): Promise<string> {
  const [session] = await connectionStrings(baseUrl, cookie, projectRef);
  if (!session) throw new Error(`no connection string for ${projectRef}`);
  return session;
}

async function widgetIds(projectRef: string): Promise<number[]> {
  const rows = await query<{ id: number }>(
    await sessionString(projectRef),
    "select id from public.widgets order by id",
  );
  return rows.map((row) => row.id);
}

function rolePassword(role: string): string {
  return sharedBoxSql("SELECT rolpassword FROM pg_authid WHERE rolname = :'role'", { role });
}

// Backup keys have one-second resolution, and a second backup in the same second is refused.
async function backUp(): Promise<BackupRow> {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const response = await postForm(baseUrl, `/_hs/projects/${ref}/backups`, {}, cookie);
  if (response.status !== 302) throw new Error(`backing up ${ref} failed: ${response.status}`);
  const [backup] = registryRows<BackupRow>(
    `SELECT b.id, b.bucket, b.s3_key AS s3Key FROM backups b JOIN projects p ON p.id = b.project_id
      WHERE p.ref = ? ORDER BY b.id DESC LIMIT 1`,
    ref,
  );
  if (!backup) throw new Error(`no backup of ${ref}`);
  return backup;
}

function restorePath(backup: BackupRow, action = "restore"): string {
  return `/_hs/projects/${ref}/backups/${backup.id}/${action}`;
}

let backup: BackupRow;

beforeAll(async () => {
  s3 = s3TestService();
  cookie = await signIn(baseUrl);
  boxId = await sharedBoxId(baseUrl, cookie);
  const saved = await postForm(baseUrl, "/_hs/settings/s3", s3Fields(s3), cookie);
  if (saved.status !== 200) throw new Error(`saving S3 settings failed: ${saved.status}`);
  const created = await createProject(baseUrl, cookie, { ref, name: ref, boxId });
  if (created.status !== 302) throw new Error(`creating ${ref} failed: ${created.status}`);
  const table = await postQuery(
    baseUrl,
    cookie,
    ref,
    `create table public.widgets (id int primary key, token uuid default extensions.gen_random_uuid());
     insert into public.widgets (id) values (1), (2)`,
  );
  if (table.status !== 200) throw new Error(`creating ${ref}.widgets failed`);
  backup = await backUp();
});

afterAll(() => {
  for (const projectRef of [ref, copyRef, brokenRef]) dropProject(projectRef);
  registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
});

describe("restore into the same project", () => {
  it("offers both restore targets for a done backup", async () => {
    const response = await fetchWith(baseUrl, cookie, restorePath(backup));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${restorePath(backup)}"`);
    expect(html).toContain(`action="${restorePath(backup, "restore-new")}"`);
    const project = await (await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}/backups`)).text();
    expect(project).toContain(`href="${restorePath(backup)}"`);
  });

  it("requires the ref to confirm", async () => {
    const response = await postForm(baseUrl, restorePath(backup), { confirm: "nope" }, cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`Type the ref ${ref} to confirm restoring into it.`);
  });

  it("returns the data to backup time with the owner and its password unchanged", async () => {
    const changes = await postQuery(
      baseUrl,
      cookie,
      ref,
      "insert into public.widgets (id) values (3); create table public.later (id int)",
    );
    expect(changes.status).toBe(200);
    const passwordBefore = rolePassword(ownerRole);
    const stringBefore = await sessionString(ref);

    const response = await postForm(baseUrl, restorePath(backup), { confirm: ref }, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/_hs/projects/${ref}/backups?restored`);

    expect(await widgetIds(ref)).toEqual([1, 2]);
    const owners = await query<{ owner: string; later: string | null }>(
      stringBefore,
      `select (select tableowner from pg_tables where tablename = 'widgets') as owner,
              to_regclass('public.later')::text as later`,
    );
    expect(owners).toEqual([{ owner: ownerRole, later: null }]);
    expect(rolePassword(ownerRole)).toBe(passwordBefore);
    expect(await sessionString(ref)).toBe(stringBefore);
  });

  it("leaves the error on the page and the database untouched when the object is gone", async () => {
    const gone = await backUp();
    deleteObject(s3, gone.s3Key);
    const response = await postForm(baseUrl, restorePath(gone), { confirm: ref }, cookie);
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain(`Could not download ${gone.s3Key}`);
    expect(html).not.toContain(s3.secretKey);
    expect(await widgetIds(ref)).toEqual([1, 2]);
  });

  it("refuses an archive that is not a dump before touching the database", async () => {
    const bad = await backUp();
    putObject(s3, bad.s3Key, "not a dump");
    const response = await postForm(baseUrl, restorePath(bad), { confirm: ref }, cookie);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain(`${bad.s3Key} is not a readable dump`);
    expect(await widgetIds(ref)).toEqual([1, 2]);
  });
});

describe("restore into a new project", () => {
  it("shows form problems on the restore page", async () => {
    const response = await postForm(
      baseUrl,
      restorePath(backup, "restore-new"),
      { name: "Copy", ref: ref, boxId },
      cookie,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`Ref ${ref} is already taken`);
  });

  it("creates the project from the bucket the backup was written to, holding its data", async () => {
    const moved = await postForm(
      baseUrl,
      "/_hs/settings/s3",
      s3Fields(s3, { bucket: `elsewhere-${suffix}` }),
      cookie,
    );
    expect(moved.status).toBe(200);
    try {
      const response = await postForm(
        baseUrl,
        restorePath(backup, "restore-new"),
        { name: "Restored copy", ref: copyRef, boxId },
        cookie,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/_hs/projects/${copyRef}/backups?restored`);
    } finally {
      await postForm(baseUrl, "/_hs/settings/s3", s3Fields(s3), cookie);
    }
    expect(backup.bucket).toBe(s3.bucket);
    expect(await widgetIds(copyRef)).toEqual([1, 2]);
    const copyOwner = `hs_${copyRef.replaceAll("-", "_")}_owner`;
    const owners = await query<{ owner: string }>(
      await sessionString(copyRef),
      "select tableowner as owner from pg_tables where tablename = 'widgets'",
    );
    expect(owners).toEqual([{ owner: copyOwner }]);
    expect(await widgetIds(ref)).toEqual([1, 2]);
  });

  it("keeps the new project and shows the error when the restore fails", async () => {
    // The owner role has only USAGE on the extensions schema, so its restore cannot recreate this.
    sharedBoxSql("CREATE TABLE extensions.admin_notes (id int)", {}, ref.replaceAll("-", "_"));
    const withAdminTable = await backUp();
    const response = await postForm(
      baseUrl,
      restorePath(withAdminTable, "restore-new"),
      { name: "Broken copy", ref: brokenRef, boxId },
      cookie,
    );
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain(`Project ${brokenRef} was created, but the backup could not be fully`);
    expect(html).toContain("Restore failed: pg_restore exited with code 1");
    expect(html).toContain("permission denied for schema extensions");
    const page = await fetchWith(baseUrl, cookie, `/_hs/projects/${brokenRef}`);
    expect(page.status).toBe(200);
    expect(objectStatus(s3, withAdminTable.s3Key).status).toBe(200);
  });
});
