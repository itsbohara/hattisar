import { createHash, randomBytes } from "node:crypto";
import type { Registry } from "../registry/db.js";
import { deleteSession, getSession, insertSession } from "../registry/sessions.js";
import { getUserById, type User } from "../registry/users.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActiveSession {
  user: User;
  tokenHash: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(db: Registry, userId: number, now: Date = new Date()): string {
  const token = randomBytes(32).toString("base64url");
  insertSession(
    db,
    {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    },
    now.toISOString(),
  );
  return token;
}

export function resolveSession(
  db: Registry,
  token: string,
  now: Date = new Date(),
): ActiveSession | undefined {
  const tokenHash = hashToken(token);
  const session = getSession(db, tokenHash);
  if (session === undefined) return undefined;
  if (session.expiresAt <= now.toISOString()) {
    deleteSession(db, tokenHash);
    return undefined;
  }
  const user = getUserById(db, session.userId);
  return user && { user, tokenHash };
}

export function endSession(db: Registry, tokenHash: string): void {
  deleteSession(db, tokenHash);
}
