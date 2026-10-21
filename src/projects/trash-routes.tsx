import { type Context, Hono } from "hono";
import { canAccess } from "../auth/access.js";
import type { AuthEnv } from "../auth/middleware.js";
import { listBoxes } from "../registry/boxes.js";
import { listProjects } from "../registry/projects.js";
import { renderPage } from "../ui/layout.js";
import { TrashPage, type TrashRow } from "../ui/pages/trash.js";
import { findAccessibleProject } from "./access.js";
import { purgeDate, purgeProject, restoreProject } from "./lifecycle.js";
import { text } from "./routes.js";
import type { ProjectServiceDeps } from "./service.js";

const TRASH_PAGE = "/_hs/trash";

export interface TrashDeps extends ProjectServiceDeps {
  purgeAfterDays: number;
}

export function trashRoutes(deps: TrashDeps): Hono<AuthEnv> {
  const { db, purgeAfterDays } = deps;
  const app = new Hono<AuthEnv>();

  const deleted = (c: Context<AuthEnv>) =>
    findAccessibleProject(db, c.var.session.user, c.req.param("ref") ?? "", "deleted");

  function renderTrash(c: Context<AuthEnv>, problem?: string, status: 200 | 400 | 502 = 200) {
    const boxes = new Map(listBoxes(db).map((box) => [box.id, box]));
    const rows: TrashRow[] = listProjects(db, "deleted").flatMap((project) => {
      const box = boxes.get(project.boxId);
      const purgeAt = purgeDate(project, purgeAfterDays);
      return box && purgeAt && canAccess(c.var.session.user, project)
        ? [{ project, box, purgeAt }]
        : [];
    });
    return renderPage(
      c,
      <TrashPage rows={rows} purgeAfterDays={purgeAfterDays} problem={problem} />,
      status,
    );
  }

  app.get(TRASH_PAGE, (c) => renderTrash(c));

  app.post(`${TRASH_PAGE}/:ref/restore`, async (c) => {
    const found = deleted(c);
    if (!found) return c.notFound();
    const result = await restoreProject(deps, found.project, found.box);
    if (result.ok) return c.redirect(`/_hs/projects/${found.project.ref}`, 302);
    return renderTrash(c, result.problem, 502);
  });

  app.post(`${TRASH_PAGE}/:ref/purge`, async (c) => {
    const found = deleted(c);
    if (!found) return c.notFound();
    if (text(await c.req.parseBody(), "confirm") !== found.project.ref) {
      return renderTrash(c, `Type the ref ${found.project.ref} to confirm purging it.`, 400);
    }
    const result = await purgeProject(deps, found.project, found.box);
    if (result.ok) return c.redirect(TRASH_PAGE, 302);
    return renderTrash(c, result.problem, 502);
  });

  return app;
}
