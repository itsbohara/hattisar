import type { MiddlewareHandler } from "hono";
import { resolveApiToken } from "../auth/api-tokens.js";
import type { Registry } from "../registry/db.js";
import type { User } from "../registry/users.js";
import { apiError } from "./errors.js";

export interface ApiEnv {
  Variables: { user: User };
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

export function requireApiToken(db: Registry): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    const resolved = token === undefined ? undefined : resolveApiToken(db, token);
    if (resolved === undefined) return apiError(c, 401, "Missing or invalid API token");
    c.set("user", resolved.user);
    return next();
  };
}
