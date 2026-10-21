import type { Registry } from "./db.js";

export interface ApiToken {
  id: number;
  userId: number;
  name: string;
  tokenHash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

const COLUMNS = `id, user_id AS userId, name, token_hash AS tokenHash, prefix, created_at AS createdAt,
  last_used_at AS lastUsedAt, expires_at AS expiresAt`;

export function insertApiToken(
  db: Registry,
  token: {
    userId: number;
    name: string;
    tokenHash: string;
    prefix: string;
    expiresAt: string | null;
  },
  now: string = new Date().toISOString(),
): ApiToken {
  return db
    .prepare<[number, string, string, string, string, string | null], ApiToken>(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .get(token.userId, token.name, token.tokenHash, token.prefix, now, token.expiresAt) as ApiToken;
}

export function listApiTokens(db: Registry, userId: number): ApiToken[] {
  return db
    .prepare<[number], ApiToken>(
      `SELECT ${COLUMNS} FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(userId);
}

export function getApiTokenByHash(db: Registry, tokenHash: string): ApiToken | undefined {
  return db
    .prepare<[string], ApiToken>(`SELECT ${COLUMNS} FROM api_tokens WHERE token_hash = ?`)
    .get(tokenHash);
}

export function touchApiToken(
  db: Registry,
  id: number,
  now: string = new Date().toISOString(),
): void {
  db.prepare<[string, number]>("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, id);
}

export function deleteApiToken(db: Registry, id: number, userId: number): boolean {
  return (
    db
      .prepare<[number, number]>("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0
  );
}

export function deleteExpiredApiTokens(db: Registry, now: string = new Date().toISOString()): void {
  db.prepare<[string]>("DELETE FROM api_tokens WHERE expires_at <= ?").run(now);
}
