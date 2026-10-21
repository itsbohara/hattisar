import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApiToken,
  resolveApiToken,
  revokeApiToken,
  type TokenExpiryDays,
} from "../../src/auth/api-tokens.js";
import {
  deleteExpiredApiTokens,
  getApiTokenByHash,
  listApiTokens,
} from "../../src/registry/api-tokens.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertUser, type User } from "../../src/registry/users.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00.000Z");

let dataDir: string;
let db: Registry;
let user: User;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-api-tokens-"));
  db = openRegistry(dataDir);
  user = insertUser(db, { username: "admin", passwordHash: "unused" });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function create(name = "ci", expiryDays: TokenExpiryDays | null = 90, now = T0) {
  const created = createApiToken(db, user.id, name, expiryDays, now);
  if (!created.ok) throw new Error(created.problem);
  return created;
}

describe("api tokens", () => {
  it("issues hs_ + 32 base64url bytes and stores only its SHA-256 and a display prefix", () => {
    const { token, row } = create("  deploy bot  ");
    expect(token.startsWith("hs_")).toBe(true);
    expect(Buffer.from(token.slice(3), "base64url")).toHaveLength(32);
    expect(row).toMatchObject({
      userId: user.id,
      name: "deploy bot",
      prefix: token.slice(0, 10),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: T0.toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(T0.getTime() + 90 * DAY).toISOString(),
    });
  });

  it("never stores the plaintext token in any column", () => {
    const { token } = create();
    const rows = db.prepare<[], Record<string, unknown>>("SELECT * FROM api_tokens").all();
    expect(rows).toHaveLength(1);
    for (const value of Object.values(rows[0] ?? {})) {
      expect(String(value)).not.toContain(token);
      expect(String(value)).not.toContain(token.slice(3));
    }
  });

  it("rejects a blank or over-long name", () => {
    expect(createApiToken(db, user.id, "   ", 90, T0)).toEqual({
      ok: false,
      problem: "Name must be 1 to 64 characters.",
    });
    expect(createApiToken(db, user.id, "x".repeat(65), 90, T0).ok).toBe(false);
    expect(createApiToken(db, user.id, "x".repeat(64), 90, T0).ok).toBe(true);
  });

  it("rejects an expiry outside the allowed choices", () => {
    const created = createApiToken(db, user.id, "ci", 7 as TokenExpiryDays, T0);
    expect(created.ok).toBe(false);
  });

  it("resolves a token to its user and touches last_used_at", () => {
    const { token, row } = create();
    const later = new Date(T0.getTime() + DAY);
    expect(resolveApiToken(db, token, later)).toEqual({
      user: expect.objectContaining({ id: user.id, username: "admin" }),
      tokenId: row.id,
    });
    expect(getApiTokenByHash(db, row.tokenHash)?.lastUsedAt).toBe(later.toISOString());
  });

  it("rejects a wrong token and an unprefixed one", () => {
    const { token } = create();
    expect(resolveApiToken(db, `hs_${"A".repeat(43)}`, T0)).toBeUndefined();
    expect(resolveApiToken(db, token.slice(3), T0)).toBeUndefined();
    expect(resolveApiToken(db, "", T0)).toBeUndefined();
  });

  it("expires at expires_at and deletes the row", () => {
    const { token, row } = create("ci", 30);
    expect(resolveApiToken(db, token, new Date(T0.getTime() + 30 * DAY - 1))).toBeDefined();
    expect(resolveApiToken(db, token, new Date(T0.getTime() + 30 * DAY))).toBeUndefined();
    expect(getApiTokenByHash(db, row.tokenHash)).toBeUndefined();
    expect(resolveApiToken(db, token, T0)).toBeUndefined();
  });

  it("purges expired tokens and keeps live and never-expiring ones", () => {
    create("short", 30);
    create("long", 90);
    create("forever", null);
    deleteExpiredApiTokens(db, new Date(T0.getTime() + 30 * DAY).toISOString());
    expect(listApiTokens(db, user.id).map((t) => t.name)).toEqual(["forever", "long"]);
  });

  it("never expires when created with no expiry", () => {
    const { token, row } = create("forever", null);
    expect(row.expiresAt).toBeNull();
    expect(resolveApiToken(db, token, new Date(T0.getTime() + 3650 * DAY))).toBeDefined();
  });

  it("lists a user's tokens newest first", () => {
    create("first", 90, T0);
    create("second", 90, new Date(T0.getTime() + DAY));
    expect(listApiTokens(db, user.id).map((t) => t.name)).toEqual(["second", "first"]);
  });

  it("revokes only the owner's token", () => {
    const { token, row } = create();
    const other = insertUser(db, { username: "other", passwordHash: "unused" });
    expect(revokeApiToken(db, other.id, row.id)).toBe(false);
    expect(resolveApiToken(db, token, T0)).toBeDefined();
    expect(revokeApiToken(db, user.id, row.id)).toBe(true);
    expect(resolveApiToken(db, token, T0)).toBeUndefined();
    expect(revokeApiToken(db, user.id, row.id)).toBe(false);
  });
});
