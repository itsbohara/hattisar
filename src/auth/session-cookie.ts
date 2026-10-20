import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_TTL_MS } from "./sessions.js";

export const SESSION_COOKIE = "hs_session";

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function writeSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
}
