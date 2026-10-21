import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { busyReason } from "../projects/locks.js";
import type { Registry } from "../registry/db.js";
import type { Project } from "../registry/projects.js";

export interface ApiErrorBody {
  error: { message: string; problems?: string[] };
}

export function errorBody(message: string, problems?: string[]): ApiErrorBody {
  return { error: problems === undefined ? { message } : { message, problems } };
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  problems?: string[],
): Response {
  return c.json(errorBody(message, problems), status);
}

export function badRequest(c: Context, problems: string[]): Response {
  return apiError(c, 400, "Invalid request", problems);
}

export function notFound(c: Context): Response {
  return apiError(c, 404, "Not found");
}

// A service reports a held project and a failing box or S3 call the same way, as one problem
// string, so the lock table decides which it was.
export function serviceFailure(
  c: Context,
  db: Registry,
  project: Project,
  problem: string,
): Response {
  return apiError(c, busyReason(db, project) === undefined ? 502 : 409, problem);
}
