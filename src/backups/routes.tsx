import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { boxConnection } from "../boxes/service.js";
import { accessibleProject, renderProjectDetail } from "../projects/routes.js";
import { getBackup } from "../registry/backups.js";
import { renderPage } from "../ui/layout.js";
import { type S3FormState, SettingsPage } from "../ui/pages/settings.js";
import { dumpFilename } from "./naming.js";
import { startDump } from "./pg-dump.js";
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

// Resolves once pg_dump has produced output, so a dump that fails to connect still gets an error
// page instead of a broken download.
function firstOutput(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("readable", resolve);
    stream.once("error", reject);
  });
}

export function backupRoutes(deps: BackupDeps): Hono<AuthEnv> {
  const { db, secretKey, pgBinDir } = deps;
  const app = new Hono<AuthEnv>();

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
    const found = accessibleProject(db, c);
    const id = c.req.param("id");
    const backup = found && /^\d+$/.test(id) ? getBackup(db, Number(id)) : undefined;
    if (!found || backup?.projectId !== found.project.id) return c.notFound();
    const result = await removeBackup(deps, backup);
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?backup-deleted`, 302);
    return renderProjectDetail(c, deps, found, { kind: "error", message: result.problem }, 502);
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
