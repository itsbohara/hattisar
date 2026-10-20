import type { MiddlewareHandler } from "hono";
import type { Registry } from "../registry/db.js";
import { classifyRequest } from "../studio/routes.js";
import { isSameOrigin } from "./origin.js";
import { readSessionCookie } from "./session-cookie.js";
import { type ActiveSession, resolveSession } from "./sessions.js";

export interface AuthEnv {
  Variables: { session: ActiveSession };
}

export const LOGIN_PAGE = "/_hs/login";
const UNAUTHORIZED_BODY = { error: { message: "Not signed in" } };
const SAFE_METHODS = new Set(["GET", "HEAD"]);

function decodedPath(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
}

// Checked on the decoded path so an encoded spelling of /_hs/ cannot skip it; an undecodable
// path is checked too.
export function requireSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const path = decodedPath(c.req.url);
    if (path !== undefined && !path.startsWith("/_hs/")) return next();
    if (!isSameOrigin(c.req.raw.headers, new URL(c.req.url).host)) {
      return c.text("Forbidden: cross-origin request", 403);
    }
    return next();
  };
}

// Public paths come from the Studio route classifier so both agree on what /_hs/login and
// /_hs/static/* mean, including how pg-meta paths are never public.
export function requireSession(db: Registry): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (classifyRequest(c.req.method, pathname).kind === "hattisar-public") return next();

    const token = readSessionCookie(c);
    const session = token === undefined ? undefined : resolveSession(db, token);
    if (session === undefined) {
      return pathname.startsWith("/api/")
        ? c.json(UNAUTHORIZED_BODY, 401)
        : c.redirect(LOGIN_PAGE, 302);
    }
    c.set("session", session);
    return next();
  };
}
