import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { boxConnection } from "../boxes/service.js";
import { slugify } from "../projects/naming.js";
import {
  accessibleProject,
  type ProjectAndBox,
  renderProjectDetail,
  text,
} from "../projects/routes.js";
import type { ProjectServiceDeps } from "../projects/service.js";
import {
  type Backup,
  type BackupSchedule,
  getBackup,
  setBackupSchedule,
} from "../registry/backups.js";
import { listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { renderPage } from "../ui/layout.js";
import type { NewProjectValues } from "../ui/pages/projects.js";
import { RestorePage } from "../ui/pages/restore.js";
import { type S3FormState, SettingsPage } from "../ui/pages/settings.js";
import { dumpFilename } from "./naming.js";
import { startDump } from "./pg-dump.js";
import { restoreIntoNewProject, restoreIntoProject } from "./restore.js";
import { testS3Connection } from "./s3.js";
import { type S3Form, saveS3Settings, storedS3Form, validateS3Form } from "./s3-settings.js";
import { type BackupDeps, removeBackup, runBackup } from "./service.js";

const PROJECTS_PAGE = "/_hs/projects";
const S3_SETTINGS = "/_hs/settings/s3";

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value.trim() : "";
}

function s3FormFrom(form: Record<string, unknown>): S3Form {
  return {
    endpoint: field(form, "endpoint"),
    region: field(form, "region"),
    bucket: field(form, "bucket"),
    accessKeyId: field(form, "accessKeyId"),
    secretAccessKey: field(form, "secretAccessKey"),
    forcePathStyle: form.forcePathStyle !== undefined,
    prefix: field(form, "prefix"),
  };
}

const FREQUENCIES: readonly string[] = ["off", "daily", "weekly"];
const MAX_KEEP = 1000;

function keepCount(value: string, min: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return count >= min && count <= MAX_KEEP ? count : undefined;
}

// keep_daily is at least 1: retention runs right after a scheduled backup and would otherwise
// delete the one just taken.
function scheduleFrom(projectId: number, form: Record<string, unknown>): BackupSchedule | string {
  const frequency = text(form, "frequency");
  const keepDaily = keepCount(text(form, "keepDaily"), 1);
  const keepWeekly = keepCount(text(form, "keepWeekly"), 0);
  if (!FREQUENCIES.includes(frequency)) return "Schedule must be off, daily or weekly.";
  if (keepDaily === undefined) return `Keep daily must be a whole number from 1 to ${MAX_KEEP}.`;
  if (keepWeekly === undefined) return `Keep weekly must be a whole number from 0 to ${MAX_KEEP}.`;
  return {
    projectId,
    frequency: frequency as BackupSchedule["frequency"],
    keepDaily,
    keepWeekly,
  };
}

function projectBackup(
  db: Registry,
  c: Context<AuthEnv>,
): { found: ProjectAndBox; backup: Backup } | undefined {
  const found = accessibleProject(db, c);
  const id = c.req.param("id") ?? "";
  const backup = found && /^\d+$/.test(id) ? getBackup(db, Number(id)) : undefined;
  if (!found || backup?.projectId !== found.project.id) return undefined;
  return { found, backup };
}

// Resolves once pg_dump has produced output, so a dump that fails to connect still gets an error
// page instead of a broken download.
function firstOutput(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("readable", resolve);
    stream.once("error", reject);
  });
}

export function backupRoutes(deps: BackupDeps, projectDeps: ProjectServiceDeps): Hono<AuthEnv> {
  const { db, secretKey, pgBinDir } = deps;
  const app = new Hono<AuthEnv>();

  function renderRestore(
    c: Context<AuthEnv>,
    { found, backup }: { found: ProjectAndBox; backup: Backup },
    problems: { values?: NewProjectValues; sameProblem?: string; newProblems?: string[] } = {},
    status: 200 | 400 | 502 = 200,
  ) {
    const name = `${found.project.name} (restored)`;
    const values = problems.values ?? { name, ref: slugify(name), boxId: found.box.id };
    return renderPage(
      c,
      <RestorePage
        project={found.project}
        backup={backup}
        boxes={listBoxes(db)}
        values={values}
        sameProblem={problems.sameProblem}
        newProblems={problems.newProblems}
      />,
      status,
    );
  }

  function renderSettings(c: Context<AuthEnv>, s3: S3FormState, status: 200 | 400 | 502 = 200) {
    return renderPage(c, <SettingsPage s3={s3} />, status);
  }

  app.get(`${PROJECTS_PAGE}/:ref/dump`, async (c) => {
    const found = accessibleProject(db, c);
    if (!found) return c.notFound();
    const { project, box } = found;
    const dump = startDump(pgBinDir, boxConnection(box, secretKey), project.dbName);
    dump.stream.on("error", (error) => {
      console.error(`hattisar: dump of ${project.ref} failed: ${error.message}`);
    });
    try {
      await firstOutput(dump.stream);
    } catch (error) {
      const message = `Could not dump the database: ${(error as Error).message}`;
      return renderProjectDetail(c, deps, found, { kind: "error", message }, 502);
    }
    // A failure after this point destroys the stream, which @hono/node-server turns into an
    // aborted response: the client never sees a truncated archive as complete.
    return new Response(Readable.toWeb(dump.stream) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${dumpFilename(project.ref, new Date())}"`,
        "cache-control": "no-store",
      },
    });
  });

  app.post(`${PROJECTS_PAGE}/:ref/backups`, async (c) => {
    const found = accessibleProject(db, c);
    if (!found) return c.notFound();
    const result = await runBackup(deps, found.project, found.box, "manual");
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?backed-up`, 302);
    return renderProjectDetail(c, deps, found, { kind: "error", message: result.problem }, 502);
  });

  app.post(`${PROJECTS_PAGE}/:ref/backups/:id/delete`, async (c) => {
    const target = projectBackup(db, c);
    if (!target) return c.notFound();
    const { found, backup } = target;
    const result = await removeBackup(deps, backup);
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?backup-deleted`, 302);
    return renderProjectDetail(c, deps, found, { kind: "error", message: result.problem }, 502);
  });

  app.post(`${PROJECTS_PAGE}/:ref/schedule`, async (c) => {
    const found = accessibleProject(db, c);
    if (!found) return c.notFound();
    const schedule = scheduleFrom(found.project.id, await c.req.parseBody());
    if (typeof schedule === "string") {
      return renderProjectDetail(c, deps, found, { kind: "error", message: schedule }, 400);
    }
    setBackupSchedule(db, schedule);
    return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?schedule-saved`, 302);
  });

  app.get(`${PROJECTS_PAGE}/:ref/backups/:id/restore`, (c) => {
    const target = projectBackup(db, c);
    if (target?.backup.status !== "done") return c.notFound();
    return renderRestore(c, target);
  });

  app.post(`${PROJECTS_PAGE}/:ref/backups/:id/restore`, async (c) => {
    const target = projectBackup(db, c);
    if (target?.backup.status !== "done") return c.notFound();
    const { found, backup } = target;
    if (text(await c.req.parseBody(), "confirm") !== found.project.ref) {
      const sameProblem = `Type the ref ${found.project.ref} to confirm restoring into it.`;
      return renderRestore(c, target, { sameProblem }, 400);
    }
    const result = await restoreIntoProject(deps, projectDeps, backup, found.project, found.box);
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?restored`, 302);
    return renderProjectDetail(c, deps, found, { kind: "error", message: result.problem }, 502);
  });

  app.post(`${PROJECTS_PAGE}/:ref/backups/:id/restore-new`, async (c) => {
    const target = projectBackup(db, c);
    if (target?.backup.status !== "done") return c.notFound();
    const form = await c.req.parseBody();
    const boxId = text(form, "boxId");
    const values = {
      name: text(form, "name"),
      ref: text(form, "ref"),
      boxId: /^\d+$/.test(boxId) ? Number(boxId) : undefined,
    };
    const result = await restoreIntoNewProject(deps, projectDeps, target.backup, {
      ...values,
      boxId: values.boxId ?? Number.NaN,
    });
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${result.project.ref}?restored`, 302);
    if ("problems" in result) {
      return renderRestore(c, target, { values, newProblems: result.problems }, 400);
    }
    const created = accessibleProject(db, c, result.project.ref);
    if (!created) return c.notFound();
    const message = `Project ${result.project.ref} was created, but the backup could not be fully restored into it: it holds part of the backup or none of it. ${result.problem}`;
    return renderProjectDetail(c, deps, created, { kind: "error", message }, 502);
  });

  app.post(S3_SETTINGS, async (c) => {
    const form = s3FormFrom(await c.req.parseBody());
    const { secretSet } = storedS3Form(db);
    const valid = validateS3Form(db, secretKey, form);
    if (Array.isArray(valid))
      return renderSettings(c, { values: form, secretSet, problems: valid }, 400);
    saveS3Settings(db, secretKey, valid);
    return renderSettings(c, { ...storedS3Form(db), saved: true });
  });

  // Tests what the form holds without saving it, so settings can be checked before they are kept.
  app.post(`${S3_SETTINGS}/test`, async (c) => {
    const form = s3FormFrom(await c.req.parseBody());
    const { secretSet } = storedS3Form(db);
    const valid = validateS3Form(db, secretKey, form);
    if (Array.isArray(valid))
      return renderSettings(c, { values: form, secretSet, problems: valid }, 400);
    const result = await testS3Connection(valid);
    const test = { ...result, secretTyped: form.secretAccessKey !== "" };
    return renderSettings(c, { values: form, secretSet, test }, result.ok ? 200 : 502);
  });

  return app;
}
