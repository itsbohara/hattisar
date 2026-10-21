import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { canAccess } from "../auth/access.js";
import type { AuthEnv } from "../auth/middleware.js";
import { isS3Configured } from "../backups/s3-settings.js";
import { createProjectOnNewBox } from "../managed/new-project.js";
import type { ManagedBoxes } from "../managed/service.js";
import { getBackupSchedule, listBackups } from "../registry/backups.js";
import { type Box, getSharedBox, listBoxes } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { listProjects } from "../registry/projects.js";
import { renderPage } from "../ui/layout.js";
import {
  NEW_BOX_OPTION,
  NewProjectPage,
  type NewProjectValues,
  ProjectPage,
  type ProjectPageNotice,
  type ProjectSort,
  ProjectsPage,
  type ProjectsQuery,
  type ProjectTab,
  type ProjectView,
  projectTabHref,
  USAGE_PATH,
} from "../ui/pages/projects.js";
import { accessibleProject, connectionStrings, type ProjectAndBox } from "./access.js";
import { softDeleteProject } from "./lifecycle.js";
import { busyReason } from "./locks.js";
import {
  createProject,
  type ProjectServiceDeps,
  renameProjectDisplay,
  rotateOwnerPassword,
} from "./service.js";
import { projectUsage } from "./usage.js";

const PROJECTS_PAGE = "/_hs/projects";
const VIEW_COOKIE = "hs_projects_view";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const isView = (value: unknown): value is ProjectView => value === "grid" || value === "list";
const isSort = (value: unknown): value is ProjectSort => value === "name" || value === "created";

function projectsQuery(c: Context<AuthEnv>): ProjectsQuery {
  const view = c.req.query("view");
  if (isView(view)) {
    setCookie(c, VIEW_COOKIE, view, { path: "/_hs", sameSite: "Lax", maxAge: ONE_YEAR_SECONDS });
  }
  const saved = getCookie(c, VIEW_COOKIE);
  const sort = c.req.query("sort");
  return {
    view: isView(view) ? view : isView(saved) ? saved : "grid",
    q: c.req.query("q")?.trim() ?? "",
    sort: isSort(sort) ? sort : "name",
  };
}

// listProjects already orders by name.
function sorted(rows: ProjectAndBox[], sort: ProjectSort): ProjectAndBox[] {
  if (sort === "name") return rows;
  return rows.toSorted((a, b) => b.project.createdAt.localeCompare(a.project.createdAt));
}

export function text(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value.trim() : "";
}

function boxIdFrom(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

export interface ProjectPageDeps {
  db: Registry;
  secretKey: Buffer;
  backupHourUtc: number;
}

export function renderProjectDetail(
  c: Context<AuthEnv>,
  { db, secretKey, backupHourUtc }: ProjectPageDeps,
  { project, box }: ProjectAndBox,
  tab: ProjectTab,
  notice?: ProjectPageNotice,
  status: 200 | 400 | 409 | 502 = 200,
) {
  const strings = connectionStrings({ project, box }, secretKey);
  return renderPage(
    c,
    <ProjectPage
      tab={tab}
      project={project}
      box={box}
      strings={strings}
      backups={listBackups(db, project.id)}
      schedule={getBackupSchedule(db, project.id)}
      backupHourUtc={backupHourUtc}
      s3Configured={isS3Configured(db)}
      notice={notice}
    />,
    status,
  );
}

const QUERY_NOTICES: Record<string, string> = {
  rotated: "Password rotated. The connection strings below use the new one.",
  renamed: "Display name saved.",
  "backed-up": "Backup finished.",
  "backup-deleted": "Backup deleted.",
  "schedule-saved": "Backup schedule saved.",
  restored: "Backup restored.",
};

function queryNotice(c: Context<AuthEnv>): ProjectPageNotice | undefined {
  const key = Object.keys(QUERY_NOTICES).find((name) => c.req.query(name) !== undefined);
  return key === undefined ? undefined : { kind: "ok", message: QUERY_NOTICES[key] as string };
}

export function projectRoutes(
  deps: ProjectServiceDeps & Pick<ProjectPageDeps, "backupHourUtc"> & { managed?: ManagedBoxes },
): Hono<AuthEnv> {
  const { db } = deps;
  const app = new Hono<AuthEnv>();
  const accessible = (c: Context<AuthEnv>) => accessibleProject(db, c);
  const renderDetail = (
    c: Context<AuthEnv>,
    found: ProjectAndBox,
    tab: ProjectTab,
    notice?: ProjectPageNotice,
    status?: 200 | 400 | 502,
  ) => renderProjectDetail(c, deps, found, tab, notice, status);

  function renderNew(c: Context<AuthEnv>, values: NewProjectValues, problems?: string[]) {
    return renderPage(
      c,
      <NewProjectPage
        boxes={listBoxes(db)}
        values={values}
        problems={problems}
        offerNewBox={deps.managed !== undefined}
      />,
      problems ? 400 : 200,
    );
  }

  function accessibleRows(c: Context<AuthEnv>, boxes: Box[]): ProjectAndBox[] {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    return listProjects(db, "active").flatMap((project) => {
      const box = byId.get(project.boxId);
      return box && canAccess(c.var.session.user, project) ? [{ project, box }] : [];
    });
  }

  app.get(PROJECTS_PAGE, (c) => {
    const query = projectsQuery(c);
    const boxes = listBoxes(db);
    const all = accessibleRows(c, boxes);
    const deleted = listProjects(db, "deleted").filter((project) =>
      canAccess(c.var.session.user, project),
    );
    const rows = sorted(all, query.sort).map((row) => ({
      ...row,
      busy: busyReason(db, row.project) !== undefined,
    }));
    const boxSummaries = boxes.map((box) => ({
      box,
      projectCount: all.filter((row) => row.box.id === box.id).length,
    }));
    return renderPage(
      c,
      <ProjectsPage rows={rows} boxes={boxSummaries} deletedCount={deleted.length} query={query} />,
    );
  });

  app.get(USAGE_PATH, async (c) => {
    const usage = await projectUsage(deps, accessibleRows(c, listBoxes(db)));
    return c.json(usage, 200, { "cache-control": "no-store" });
  });

  app.get(`${PROJECTS_PAGE}/new`, (c) =>
    renderNew(c, { name: "", ref: "", boxId: getSharedBox(db)?.id }),
  );

  app.post(PROJECTS_PAGE, async (c) => {
    const form = await c.req.parseBody();
    const values = { name: text(form, "name"), ref: text(form, "ref") };
    const managed = text(form, "boxId") === NEW_BOX_OPTION ? deps.managed : undefined;
    const boxId = boxIdFrom(text(form, "boxId"));
    const result = managed
      ? await createProjectOnNewBox(deps, managed, values)
      : await createProject(deps, { ...values, boxId: boxId ?? Number.NaN });
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${result.project.ref}`, 302);
    return renderNew(c, { ...values, boxId, newBox: managed !== undefined }, result.problems);
  });

  const TAB_PATHS: [string, ProjectTab][] = [
    ["", "connect"],
    ["/backups", "backups"],
    ["/settings", "general"],
  ];
  for (const [path, tab] of TAB_PATHS) {
    app.get(`${PROJECTS_PAGE}/:ref${path}`, (c) => {
      const found = accessible(c);
      if (!found) return c.notFound();
      return renderDetail(c, found, tab, queryNotice(c));
    });
  }

  app.post(`${PROJECTS_PAGE}/:ref/name`, async (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    const result = renameProjectDisplay(db, found.project, text(await c.req.parseBody(), "name"));
    if (result.ok)
      return c.redirect(`${projectTabHref(found.project.ref, "general")}?renamed`, 302);
    return renderDetail(c, found, "general", { kind: "error", message: result.problem }, 400);
  });

  app.post(`${PROJECTS_PAGE}/:ref/rotate`, async (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    const result = await rotateOwnerPassword(deps, found.project, found.box);
    if (result.ok) return c.redirect(`${PROJECTS_PAGE}/${found.project.ref}?rotated`, 302);
    return renderDetail(c, found, "connect", { kind: "error", message: result.problem }, 502);
  });

  app.post(`${PROJECTS_PAGE}/:ref/delete`, async (c) => {
    const found = accessible(c);
    if (!found) return c.notFound();
    if (text(await c.req.parseBody(), "confirm") !== found.project.ref) {
      const message = `Type the ref ${found.project.ref} to confirm deleting the project.`;
      return renderDetail(c, found, "general", { kind: "error", message }, 400);
    }
    const result = await softDeleteProject(deps, found.project, found.box);
    if (result.ok) return c.redirect("/_hs/trash", 302);
    return renderDetail(c, found, "general", { kind: "error", message: result.problem }, 502);
  });

  return app;
}
