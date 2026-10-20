import { SESSION_COOKIE } from "../../src/auth/session-cookie.js";
import { createSession } from "../../src/auth/sessions.js";
import type { Registry } from "../../src/registry/db.js";
import { getUserByUsername, insertUser } from "../../src/registry/users.js";
import { stackEnv } from "../stack.js";

export interface Credentials {
  username: string;
  password: string;
}

let stackAdmin: Credentials | undefined;

// The stack seeded its admin from docker/.env (scripts/dev-env.sh) on first boot; compose resolves
// the same file. A hattisar-data volume seeded from an older .env will not accept this password.
export function adminCredentials(): Credentials {
  if (stackAdmin) return stackAdmin;
  const env = stackEnv();
  const password = env.HATTISAR_ADMIN_PASSWORD;
  if (!password) throw new Error("HATTISAR_ADMIN_PASSWORD is not set for the stack");
  stackAdmin = { username: env.HATTISAR_ADMIN_USERNAME || "admin", password };
  return stackAdmin;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

export function postForm(
  baseUrl: string,
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: baseUrl };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers,
    body: new URLSearchParams(fields),
  });
}

export function tokenFrom(response: Response): string | undefined {
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return setCookie?.slice(SESSION_COOKIE.length + 1).split(";")[0] || undefined;
}

// Returns a Cookie header value for a fresh session of the stack's admin.
export async function signIn(
  baseUrl: string,
  credentials: Credentials = adminCredentials(),
): Promise<string> {
  const response = await postForm(baseUrl, "/_hs/login", { ...credentials });
  const token = tokenFrom(response);
  if (response.status !== 302 || token === undefined) {
    throw new Error(`signing in as ${credentials.username} failed with ${response.status}`);
  }
  return sessionCookie(token);
}

// In-process apps: a session straight in the registry, creating the user when missing.
export function signInToRegistry(db: Registry, username = "admin"): string {
  const user =
    getUserByUsername(db, username) ?? insertUser(db, { username, passwordHash: "unused" });
  return sessionCookie(createSession(db, user.id));
}
