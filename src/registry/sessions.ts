import type { Registry } from "./db.js";

export interface Session {
  tokenHash: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
}

const COLUMNS = `token_hash AS tokenHash, user_id AS userId, created_at AS createdAt,
  expires_at AS expiresAt`;

export function insertSession(
  db: Registry,
  session: { tokenHash: string; userId: number; expiresAt: string },
  now: string = new Date().toISOString(),
): Session {
  return db
    .prepare<[string, number, string, string], Session>(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(session.tokenHash, session.userId, now, session.expiresAt) as Session;
}

export function getSession(db: Registry, tokenHash: string): Session | undefined {
  return db
    .prepare<[string], Session>(`SELECT ${COLUMNS} FROM sessions WHERE token_hash = ?`)
    .get(tokenHash);
}

export function deleteSession(db: Registry, tokenHash: string): void {
  db.prepare<[string]>("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteOtherSessions(db: Registry, userId: number, keepTokenHash: string): void {
  db.prepare<[number, string]>("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(
    userId,
    keepTokenHash,
  );
}

export function deleteExpiredSessions(db: Registry, now: string = new Date().toISOString()): void {
  db.prepare<[string]>("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}
