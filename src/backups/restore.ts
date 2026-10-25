import type { Dirent } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { type BoxConnection, safeErrorMessage } from "../boxes/admin-client.js";
import { attachedProblem, isAttached } from "../projects/attach.js";
import { holdingProject, type ProjectOperation } from "../projects/locks.js";
import {
  createProject,
  createProjectDatabase,
  type ProjectForm,
  type ProjectServiceDeps,
  validateProjectForm,
} from "../projects/service.js";
import type { Backup } from "../registry/backups.js";
import type { Box } from "../registry/boxes.js";
import type { Project } from "../registry/projects.js";
import { restoreArchive, writeRestoreList } from "./pg-restore.js";
import { downloadBackupObject, s3ErrorMessage } from "./s3.js";
import { loadS3Settings, type S3Settings } from "./s3-settings.js";
import { type BackupDeps, type BackupOutcome, boxCredentials, NOT_CONFIGURED } from "./service.js";

const WORK_DIR_PREFIX = "restore-";

const RESTORE: ProjectOperation = {
  action: "restore a backup into",
  holds: "it is being restored",
  status: "active",
};

export type NewProjectRestore =
  | { ok: true; project: Project }
  | { ok: false; problems: string[] }
  | { ok: false; project: Project; problem: string };

interface Archive {
  archive: string;
  list: string;
}

function restorable(deps: BackupDeps, backup: Backup): S3Settings | string {
  if (backup.status !== "done") return "Only a finished backup can be restored.";
  return loadS3Settings(deps.db, deps.secretKey) ?? NOT_CONFIGURED;
}

async function inWorkDir<T>(dataDir: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(dataDir, WORK_DIR_PREFIX));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeStaleRestoreDirs(dataDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    console.warn(
      `hattisar: could not list ${dataDir} for stale restore directories: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_DIR_PREFIX)) continue;
    try {
      await rm(join(dataDir, entry.name), { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `hattisar: could not remove stale ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// The whole archive is on disk and readable before any database is touched: pg_restore can pause
// reading for minutes while it builds an index, longer than an S3 connection may sit idle.
async function fetchArchive(
  deps: BackupDeps,
  settings: S3Settings,
  backup: Backup,
  dir: string,
): Promise<Archive | string> {
  const archive = join(dir, "backup.dump");
  const list = join(dir, "restore.list");
  try {
    await downloadBackupObject(settings, backup, archive);
  } catch (error) {
    return `Could not download ${backup.s3Key}: ${s3ErrorMessage(error, settings)}`;
  }
  try {
    await writeRestoreList(deps.pgBinDir, archive, list);
  } catch (error) {
    return `${backup.s3Key} is not a readable dump: ${(error as Error).message}`;
  }
  return { archive, list };
}

async function restoreInto(
  deps: BackupDeps,
  conn: BoxConnection,
  project: Project,
  { archive, list }: Archive,
): Promise<BackupOutcome> {
  try {
    await restoreArchive(deps.pgBinDir, conn, project, archive, list);
    return { ok: true };
  } catch (error) {
    return { ok: false, problem: `Restore failed: ${(error as Error).message}` };
  }
}

// §8 (a): drop and recreate the database with the §7 steps; the owner role and its password stay.
export async function restoreIntoProject(
  deps: BackupDeps,
  projectDeps: ProjectServiceDeps,
  backup: Backup,
  project: Project,
  box: Box,
): Promise<BackupOutcome> {
  if (isAttached(project)) return { ok: false, problem: attachedProblem(project.ref) };
  const settings = restorable(deps, backup);
  if (typeof settings === "string") return { ok: false, problem: settings };
  const conn = boxCredentials(box, deps.secretKey);
  if (typeof conn === "string") return { ok: false, problem: conn };
  return holdingProject(deps.db, project, RESTORE, (current) =>
    inWorkDir(deps.dataDir, async (dir) => {
      const fetched = await fetchArchive(deps, settings, backup, dir);
      if (typeof fetched === "string") return { ok: false, problem: fetched };
      try {
        await projectDeps.admin(conn, (client) =>
          client.query(
            `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(current.dbName)} WITH (FORCE)`,
          ),
        );
        await createProjectDatabase(projectDeps.admin, conn, box, current);
      } catch (error) {
        const message = safeErrorMessage(error, conn.password);
        return {
          ok: false,
          problem: `Could not recreate database ${current.dbName}: ${message}. Restore again to bring it back.`,
        };
      }
      const restored = await restoreInto(deps, conn, current, fetched);
      if (restored.ok) return restored;
      // Leads the message: pg_restore's stderr tail after it can run to kilobytes.
      return {
        ok: false,
        problem: `The previous data of ${current.ref} was replaced and its database now holds part of the backup. Restore again to finish. ${restored.problem}`,
      };
    }),
  );
}

// §8 (b): the full create flow, then the same restore. A project whose restore fails is kept: it
// exists and works, it just holds part of the backup or none of it.
export async function restoreIntoNewProject(
  deps: BackupDeps,
  projectDeps: ProjectServiceDeps,
  backup: Backup,
  form: ProjectForm,
): Promise<NewProjectRestore> {
  const settings = restorable(deps, backup);
  if (typeof settings === "string") return { ok: false, problems: [settings] };
  const valid = validateProjectForm(deps.db, form);
  if (Array.isArray(valid)) return { ok: false, problems: valid };
  const conn = boxCredentials(valid.box, deps.secretKey);
  if (typeof conn === "string") return { ok: false, problems: [conn] };
  return inWorkDir(deps.dataDir, async (dir) => {
    const fetched = await fetchArchive(deps, settings, backup, dir);
    if (typeof fetched === "string") return { ok: false, problems: [fetched] };
    const created = await createProject(projectDeps, form);
    if (!created.ok) return created;
    const { project } = created;
    const restored = await holdingProject(deps.db, project, RESTORE, (current) =>
      restoreInto(deps, conn, current, fetched),
    );
    return restored.ok ? { ok: true, project } : { ok: false, project, problem: restored.problem };
  });
}
