import type { MiddlewareHandler } from "hono";
import type { Registry } from "../registry/db.js";
import { API_PREFIX, classifyRequest } from "../studio/routes.js";
import { isSameOrigin } from "./origin.js";
import { readSessionCookie } from "./session-cookie.js";
import { type ActiveSession, resolveSession } from "./sessions.js";

export interface AuthEnv {
  Variables: { session: ActiveSession };
}

export const LOGIN_PAGE = "/_hs/login";
const UNAUTHORIZED_BODY = { error: { message: "Not signed in" } };
const SAFE_METHODS = new Set(["GET", "HEAD"]);

// Both checks below are skipped for the token API, which never reads the cookie. The classifier
// decodes %2F and Hono's router does not, so the raw path must agree too: a path only the
// classifier calls API would reach a non-API handler with no session and no origin check.
function isTokenApiRequest(method: string, pathname: string): boolean {
  const onApiPath = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
  return onApiPath && classifyRequest(method, pathname).kind === "hattisar-api";
}

// Every unsafe method, not only /_hs/*: the proxied /api/* routes run SQL, and a text/plain POST
// from another site needs no CORS preflight.
export function requireSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (isTokenApiRequest(c.req.method, new URL(c.req.url).pathname)) return next();
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
    if (isTokenApiRequest(c.req.method, pathname)) return next();

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
