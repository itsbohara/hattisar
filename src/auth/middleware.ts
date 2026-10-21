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

// Every unsafe method, not only /_hs/*: the proxied /api/* routes run SQL, and a text/plain POST
// from another site needs no CORS preflight. The token API is exempt because it never reads the
// cookie, so a cross-site request carries no credential the browser added on its own.
export function requireSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (classifyRequest(c.req.method, new URL(c.req.url).pathname).kind === "hattisar-api") {
      return next();
    }
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
    const { kind } = classifyRequest(c.req.method, pathname);
    // The token API authenticates itself (requireApiToken) and must never accept the cookie.
    if (kind === "hattisar-public" || kind === "hattisar-api") return next();

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
