import { type Context, Hono } from "hono";
import { canAccess } from "../auth/access.js";
import type { AuthEnv } from "../auth/middleware.js";
import { isS3Configured } from "../backups/s3-settings.js";
import { listBackups } from "../registry/backups.js";
import { type Box, getBoxById, getSharedBox, listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { getProjectByRef, listProjects, type Project } from "../registry/projects.js";
import { renderPage } from "../ui/layout.js";
import {
  NewProjectPage,
  type NewProjectValues,
  ProjectPage,
  type ProjectPageNotice,
  ProjectsPage,
} from "../ui/pages/projects.js";
import { ownerConnectionStrings } from "./connection-strings.js";
import { softDeleteProject } from "./lifecycle.js";
import {
  createProject,
  ownerPassword,
  type ProjectServiceDeps,
  renameProjectDisplay,
  rotateOwnerPassword,
} from "./service.js";

const PROJECTS_PAGE = "/_hs/projects";

export function text(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value.trim() : "";
}

function boxIdFrom(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

export interface ProjectAndBox {
  project: Project;
  box: Box;
}

// Unknown, deleted and forbidden projects all look the same: not found.
export function accessibleProject(db: Registry, c: Context<AuthEnv>): ProjectAndBox | undefined {
  const project = getProjectByRef(db, c.req.param("ref") ?? "");
  if (project?.status !== "active" || !canAccess(c.var.session.user, project)) return undefined;
  const box = getBoxById(db, project.boxId);
  return box && { project, box };
}

export function renderProjectDetail(
  c: Context<AuthEnv>,
  { db, secretKey }: { db: Registry; secretKey: Buffer },
  { project, box }: ProjectAndBox,
  notice?: ProjectPageNotice,
  status: 200 | 400 | 502 = 200,
) {
  const strings = ownerConnectionStrings(box, project, ownerPassword(project, secretKey));
  return renderPage(
    c,
    <ProjectPage
      project={project}
      box={box}
      strings={strings}
      backups={listBackups(db, project.id)}
      s3Configured={isS3Configured(db)}
      notice={notice}
    />,
    status,
  );
}

const QUERY_NOTICES: Record<string, string> = {
  rotated: "Password rotated. The connection strings below use the new one.",
  "backed-up": "Backup finished.",
  "backup-deleted": "Backup deleted.",
};

function queryNotice(c: Context<AuthEnv>): ProjectPageNotice | undefined {
  const key = Object.keys(QUERY_NOTICES).find((name) => c.req.query(name) !== undefined);
  return key === undefined ? undefined : { kind: "ok", message: QUERY_NOTICES[key] as string };
}

export function projectRoutes(deps: ProjectServiceDeps): Hono<AuthEnv> {
  const { db } = deps;
  const app = new Hono<AuthEnv>();
  const accessible = (c: Context<AuthEnv>) => accessibleProject(db, c);
  const renderDetail = (
    c: Context<AuthEnv>,
    found: ProjectAndBox,
    notice?: ProjectPageNotice,
    status?: 200 | 400 | 502,
  ) => renderProjectDetail(c, deps, found, notice, status);

  function renderNew(c: Context<AuthEnv>, values: NewProjectValues, problems?: string[]) {
    return renderPage(
      c,
      <NewProjectPage boxes={listBoxes(db)} values={values} problems={problems} />,
      problems ? 400 : 200,
    );
  }

  app.get(PROJECTS_PAGE, (c) => {
    const boxes = new Map(listBoxes(db).map((box) => [box.id, box]));
    const rows = listProjects(db, "active").flatMap((project) => {
      const box = boxes.get(project.boxId);
      return box && canAccess(c.var.session.user, project) ? [{ project, box }] : [];
    });
    return renderPage(c, <ProjectsPage rows={rows} />);
  });

  app.get(`${PROJECTS_PAGE}/new`, (c) =>
    renderNew(c, { name: "", ref: "", boxId: getSharedBox(db)?.id }),
  );

  app.post(PROJECTS_PAGE, async (c) => {
    const form = await c.req.parseBody();
    const values = { name: text(form, "name"), ref: text(form, "ref") };
    const boxId = boxIdFrom(text(form, "boxId"));
    const result = await createProject(deps, { ...values, boxId: boxId ?? Number.NaN });
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${result.project.ref}`, 302);
    return renderNew(c, { ...values, boxId }, result.problems);
  });

  app.get(`${PROJECTS_PAGE}/:ref`, (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    return renderDetail(c, found, queryNotice(c));
  });

  app.post(`${PROJECTS_PAGE}/:ref/name`, async (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    const result = renameProjectDisplay(db, found.project, text(await c.req.parseBody(), "name"));
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}`, 302);
    return renderDetail(c, found, { kind: "error", message: result.problem }, 400);
  });

  app.post(`${PROJECTS_PAGE}/:ref/rotate`, async (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    const result = await rotateOwnerPassword(deps, found.project, found.box);
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?rotated`, 302);
    return renderDetail(c, found, { kind: "error", message: result.problem }, 502);
  });

  app.post(`${PROJECTS_PAGE}/:ref/delete`, async (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    if (text(await c.req.parseBody(), "confirm") !== found.project.ref) {
      const message = `Type the ref ${found.project.ref} to confirm deleting the project.`;
      return renderDetail(c, found, { kind: "error", message }, 400);
    }
    const result = await softDeleteProject(deps, found.project, found.box);
    if (result.ok) return c.redirect("/_hs/trash", 302);
    return renderDetail(c, found, { kind: "error", message: result.problem }, 502);
  });

  return app;
}
