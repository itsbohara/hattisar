import { type Context, Hono } from "hono";
import { restoreIntoProject } from "../backups/restore.js";
import { type BackupDeps, NOT_CONFIGURED, runBackup } from "../backups/service.js";
import { findAccessibleProject, type ProjectAndBox } from "../projects/access.js";
import { attachedProblem, isAttached } from "../projects/attach.js";
import type { ProjectServiceDeps } from "../projects/service.js";
import { type Backup, getBackup, listBackups } from "../registry/backups.js";
import type { Project } from "../registry/projects.js";
import type { ApiEnv } from "./auth.js";
import { apiError, badRequest, notFound, serviceFailure } from "./errors.js";
import { jsonObject } from "./projects.js";

function backupJson({ id, kind, status, sizeBytes, error, createdAt, finishedAt }: Backup) {
  return { id, kind, status, sizeBytes, error, createdAt, finishedAt };
}

export function backupApiRoutes(deps: BackupDeps, projectDeps: ProjectServiceDeps): Hono<ApiEnv> {
  const { db } = deps;
  const app = new Hono<ApiEnv>();
  const accessible = (c: Context<ApiEnv>) =>
    findAccessibleProject(db, c.var.user, c.req.param("ref") ?? "");

  // Missing S3 settings are the caller's to fix, not a box failure.
  const failure = (c: Context<ApiEnv>, project: Project, problem: string) =>
    problem === NOT_CONFIGURED
      ? apiError(c, 400, NOT_CONFIGURED)
      : serviceFailure(c, db, project, problem);

  function restorableBackup(
    c: Context<ApiEnv>,
  ): { found: ProjectAndBox; backup: Backup } | undefined {
    const found = accessible(c);
    const id = c.req.param("id") ?? "";
    const backup = found && /^\d+$/.test(id) ? getBackup(db, Number(id)) : undefined;
    if (!found || backup?.projectId !== found.project.id || backup.status !== "done") {
      return undefined;
    }
    return { found, backup };
  }

  app.get("/:ref/backups", (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    return c.json(listBackups(db, found.project.id).map(backupJson));
  });

  app.post("/:ref/backups", async (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    const result = await runBackup(deps, found.project, found.box, "manual");
    if (!result.ok) return failure(c, found.project, result.problem);
    return c.json(backupJson(result.backup), 201);
  });

  app.post("/:ref/backups/:id/restore", async (c) => {
    const target = restorableBackup(c);
    if (!target) return notFound(c);
    const { found, backup } = target;
    if (isAttached(found.project)) return apiError(c, 409, attachedProblem(found.project.ref));
    const body = await jsonObject(c);
    if (body === undefined) return badRequest(c, ["Body must be a JSON object."]);
    if (body.confirm !== found.project.ref) {
      return badRequest(c, [`Type the ref ${found.project.ref} to confirm restoring into it.`]);
    }
    const result = await restoreIntoProject(deps, projectDeps, backup, found.project, found.box);
    if (!result.ok) return failure(c, found.project, result.problem);
    return c.json({ ok: true });
  });

  return app;
}
