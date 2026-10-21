import { randomBytes } from "node:crypto";
import {
  type ApiToken,
  deleteApiToken,
  getApiTokenByHash,
  insertApiToken,
  touchApiToken,
} from "../registry/api-tokens.js";
import type { Registry } from "../registry/db.js";
import { getUserById, type User } from "../registry/users.js";
import { hashToken } from "./sessions.js";

export const TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

const TOKEN_PREFIX = "hs_";
const DISPLAY_PREFIX_LENGTH = 10;
const MAX_NAME_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenExpiryDays = (typeof TOKEN_EXPIRY_DAYS)[number];

export type CreateApiTokenResult =
  | { ok: true; token: string; row: ApiToken }
  | { ok: false; problem: string };

export function createApiToken(
  db: Registry,
  userId: number,
  name: string,
  expiryDays: TokenExpiryDays | null,
  now: Date = new Date(),
): CreateApiTokenResult {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, problem: `Name must be 1 to ${MAX_NAME_LENGTH} characters.` };
  }
  if (expiryDays !== null && !TOKEN_EXPIRY_DAYS.includes(expiryDays)) {
    return { ok: false, problem: `Expiry must be ${TOKEN_EXPIRY_DAYS.join(", ")} days or never.` };
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const row = insertApiToken(
    db,
    {
      userId,
      name: trimmed,
      tokenHash: hashToken(token),
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      expiresAt:
        expiryDays === null ? null : new Date(now.getTime() + expiryDays * DAY_MS).toISOString(),
    },
    now.toISOString(),
  );
  return { ok: true, token, row };
}

export function resolveApiToken(
  db: Registry,
  token: string,
  now: Date = new Date(),
): { user: User; tokenId: number } | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const row = getApiTokenByHash(db, hashToken(token));
  if (row === undefined) return undefined;
  if (row.expiresAt !== null && row.expiresAt <= now.toISOString()) {
    deleteApiToken(db, row.id, row.userId);
    return undefined;
  }
  const user = getUserById(db, row.userId);
  if (user === undefined) return undefined;
  touchApiToken(db, row.id, now.toISOString());
  return { user, tokenId: row.id };
}

export function revokeApiToken(db: Registry, userId: number, id: number): boolean {
  return deleteApiToken(db, id, userId);
}
