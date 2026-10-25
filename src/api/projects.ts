import { type Context, Hono } from "hono";
import { canAccess } from "../auth/access.js";
import { createProjectOnNewBox } from "../managed/new-project.js";
import type { ManagedBoxes } from "../managed/service.js";
import {
  connectionStrings,
  findAccessibleProject,
  type ProjectAndBox,
} from "../projects/access.js";
import {
  attachedProblem,
  attachProject,
  detachProject,
  isAttached,
  updateProjectLogin,
} from "../projects/attach.js";
import { restoreProject, softDeleteProject } from "../projects/lifecycle.js";
import { slugify } from "../projects/naming.js";
import {
  createProject,
  type ProjectServiceDeps,
  rotateOwnerPassword,
} from "../projects/service.js";
import { getSharedBox, listBoxes } from "../registry/boxes.js";
import { listProjects, type ProjectStatus } from "../registry/projects.js";
import type { ApiEnv } from "./auth.js";
import { apiError, badRequest, notFound, serviceFailure } from "./errors.js";

export type ProjectApiDeps = ProjectServiceDeps & { managed?: ManagedBoxes };

const UNREADABLE_PASSWORD = "The project's password could not be decrypted. Rotate it to repair.";
const UNREADABLE_LOGIN_PASSWORD =
  "The project's password could not be decrypted. Update its login to repair.";

const createdProblem = (ref: string) => `${ref} was created by hattisar, not attached.`;

function projectJson({ project, box }: ProjectAndBox) {
  return {
    ref: project.ref,
    name: project.name,
    kind: project.kind,
    status: project.status,
    box: { id: box.id, name: box.name, kind: box.kind },
    createdAt: project.createdAt,
    deletedAt: project.deletedAt,
  };
}

export async function jsonObject(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface CreateFields {
  name: string;
  ref?: string;
  boxId?: number;
  newBox: boolean;
}

function createFields(body: Record<string, unknown>): CreateFields | string[] {
  const { name = "", ref, boxId, newBox = false } = body;
  const problems: string[] = [];
  if (typeof name !== "string") problems.push("name must be a string.");
  if (ref !== undefined && typeof ref !== "string") problems.push("ref must be a string.");
  if (boxId !== undefined && !Number.isInteger(boxId)) problems.push("boxId must be an integer.");
  if (typeof newBox !== "boolean") problems.push("newBox must be a boolean.");
  if (problems.length > 0) return problems;
  return {
    name: (name as string).trim(),
    ref: (ref as string | undefined)?.trim() || undefined,
    boxId: boxId as number | undefined,
    newBox: newBox as boolean,
  };
}

interface AttachFields {
  name: string;
  ref?: string;
  boxId: number;
  database: string;
  login: string;
  password: string;
}

function stringProblems(body: Record<string, unknown>, names: string[]): string[] {
  return names.flatMap((name) =>
    typeof body[name] === "string" ? [] : [`${name} must be a string.`],
  );
}

function attachFields(body: Record<string, unknown>): AttachFields | string[] {
  const { name, ref, boxId, database, login, password } = body;
  const problems = stringProblems(body, ["name", "database", "login", "password"]);
  if (ref !== undefined && typeof ref !== "string") problems.push("ref must be a string.");
  if (!Number.isInteger(boxId)) problems.push("boxId must be an integer.");
  if (problems.length > 0) return problems;
  return {
    name: (name as string).trim(),
    ref: (ref as string | undefined)?.trim() || undefined,
    boxId: boxId as number,
    database: database as string,
    login: login as string,
    password: password as string,
  };
}

export function projectApiRoutes(deps: ProjectApiDeps): Hono<ApiEnv> {
  const { db, secretKey, poolerHost } = deps;
  const app = new Hono<ApiEnv>();
  const accessible = (c: Context<ApiEnv>, status?: ProjectStatus) =>
    findAccessibleProject(db, c.var.user, c.req.param("ref") ?? "", status);
  const reread = (c: Context<ApiEnv>, ref: string) => {
    const found = findAccessibleProject(db, c.var.user, ref);
    if (!found) throw new Error(`Project ${ref} is not readable after a successful change`);
    return found;
  };

  app.get("/", (c) => {
    const status = c.req.query("status") ?? "active";
    if (status !== "active" && status !== "deleted") {
      return badRequest(c, ["status must be active or deleted."]);
    }
    const boxes = new Map(listBoxes(db).map((box) => [box.id, box]));
    return c.json(
      listProjects(db, status).flatMap((project) => {
        const box = boxes.get(project.boxId);
        return box && canAccess(c.var.user, project) ? [projectJson({ project, box })] : [];
      }),
    );
  });

  app.post("/", async (c) => {
    const body = await jsonObject(c);
    if (body === undefined) return badRequest(c, ["Body must be a JSON object."]);
    const fields = createFields(body);
    if (Array.isArray(fields)) return badRequest(c, fields);
    if (fields.newBox && fields.boxId !== undefined) {
      return badRequest(c, ["Give either boxId or newBox, not both."]);
    }
    if (fields.newBox && deps.managed === undefined) {
      return badRequest(c, ["Managed boxes are not enabled."]);
    }
    const values = { name: fields.name, ref: fields.ref ?? slugify(fields.name) };
    const result =
      fields.newBox && deps.managed
        ? await createProjectOnNewBox(deps, deps.managed, values)
        : await createProject(deps, {
            ...values,
            boxId: fields.boxId ?? getSharedBox(db)?.id ?? Number.NaN,
          });
    if (!result.ok) return badRequest(c, result.problems);
    return c.json(projectJson(reread(c, result.project.ref)), 201);
  });

  app.post("/attach", async (c) => {
    const body = await jsonObject(c);
    if (body === undefined) return badRequest(c, ["Body must be a JSON object."]);
    const fields = attachFields(body);
    if (Array.isArray(fields)) return badRequest(c, fields);
    const result = await attachProject(deps, {
      ...fields,
      ref: fields.ref ?? slugify(fields.name),
    });
    if (!result.ok) return badRequest(c, result.problems);
    return c.json(projectJson(reread(c, result.project.ref)), 201);
  });

  app.get("/:ref", (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    const connections = (connectionStrings(found, secretKey, poolerHost) ?? []).map(
      ({ label, kind, masked }) => ({ label, kind, masked }),
    );
    return c.json({ ...projectJson(found), connections });
  });

  app.get("/:ref/connections", (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    const strings = connectionStrings(found, secretKey, poolerHost);
    if (strings === undefined) {
      return apiError(
        c,
        502,
        isAttached(found.project) ? UNREADABLE_LOGIN_PASSWORD : UNREADABLE_PASSWORD,
      );
    }
    return c.json(strings.map(({ label, kind, url }) => ({ label, kind, url })));
  });

  app.post("/:ref/rotate", async (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    if (isAttached(found.project)) return apiError(c, 409, attachedProblem(found.project.ref));
    const result = await rotateOwnerPassword(deps, found.project, found.box);
    if (!result.ok) return serviceFailure(c, db, found.project, result.problem);
    return c.json({ ok: true });
  });

  app.delete("/:ref", async (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    if (isAttached(found.project)) return apiError(c, 409, attachedProblem(found.project.ref));
    const body = await jsonObject(c);
    if (body === undefined) return badRequest(c, ["Body must be a JSON object."]);
    if (body.confirm !== found.project.ref) {
      return badRequest(c, [`Type the ref ${found.project.ref} to confirm deleting the project.`]);
    }
    const result = await softDeleteProject(deps, found.project, found.box);
    if (!result.ok) return serviceFailure(c, db, found.project, result.problem);
    return c.json({ ok: true });
  });

  app.post("/:ref/undelete", async (c) => {
    const found = accessible(c, "deleted");
    if (!found) return notFound(c);
    if (isAttached(found.project)) return apiError(c, 409, attachedProblem(found.project.ref));
    const result = await restoreProject(deps, found.project, found.box);
    if (!result.ok) return serviceFailure(c, db, found.project, result.problem);
    return c.json(projectJson(reread(c, found.project.ref)));
  });

  app.put("/:ref/login", async (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    if (!isAttached(found.project)) return apiError(c, 409, createdProblem(found.project.ref));
    const body = await jsonObject(c);
    if (body === undefined) return badRequest(c, ["Body must be a JSON object."]);
    const problems = stringProblems(body, ["login", "password"]);
    if (problems.length > 0) return badRequest(c, problems);
    const result = await updateProjectLogin(
      deps,
      found.project,
      found.box,
      body.login as string,
      body.password as string,
    );
    if (!result.ok) return serviceFailure(c, db, found.project, result.problem);
    return c.json({ ok: true });
  });

  app.post("/:ref/detach", async (c) => {
    const found = accessible(c);
    if (!found) return notFound(c);
    if (!isAttached(found.project)) return apiError(c, 409, createdProblem(found.project.ref));
    const body = await jsonObject(c);
    if (body === undefined) return badRequest(c, ["Body must be a JSON object."]);
    if (body.confirm !== found.project.ref) {
      return badRequest(c, [`Type the ref ${found.project.ref} to confirm detaching the project.`]);
    }
    const result = await detachProject(deps, found.project);
    if (!result.ok) return serviceFailure(c, db, found.project, result.problem);
    return c.json({ ok: true });
  });

  return app;
}
