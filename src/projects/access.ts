import type { Context } from "hono";
import { canAccess } from "../auth/access.js";
import type { AuthEnv } from "../auth/middleware.js";
import { type Box, getBoxById } from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { getProjectByRef, type Project, type ProjectStatus } from "../registry/projects.js";
import { SecretError } from "../registry/secrets.js";
import type { User } from "../registry/users.js";
import { type ConnectionString, ownerConnectionStrings } from "./connection-strings.js";
import { ownerPassword } from "./service.js";

export interface ProjectAndBox {
  project: Project;
  box: Box;
}

// Unknown, forbidden and other-status projects all look the same: not found.
export function findAccessibleProject(
  db: Registry,
  user: Pick<User, "id">,
  ref: string,
  status: ProjectStatus = "active",
): ProjectAndBox | undefined {
  const project = getProjectByRef(db, ref);
  if (project?.status !== status || !canAccess(user, project)) return undefined;
  const box = getBoxById(db, project.boxId);
  return box && { project, box };
}

export function accessibleProject(
  db: Registry,
  c: Context<AuthEnv>,
  ref: string = c.req.param("ref") ?? "",
): ProjectAndBox | undefined {
  return findAccessibleProject(db, c.var.session.user, ref);
}

// A secret that will not decrypt leaves the page usable: rotating is how it gets repaired.
export function connectionStrings(
  { project, box }: ProjectAndBox,
  secretKey: Buffer,
): ConnectionString[] | undefined {
  try {
    return ownerConnectionStrings(box, project, ownerPassword(project, secretKey));
  } catch (error) {
    if (error instanceof SecretError) return undefined;
    throw error;
  }
}
