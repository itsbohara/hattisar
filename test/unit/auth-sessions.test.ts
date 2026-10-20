import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, endSession, resolveSession } from "../../src/auth/sessions.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { getSession } from "../../src/registry/sessions.js";
import { insertUser, type User } from "../../src/registry/users.js";

const DAY = 24 * 60 * 60 * 1000;

let dataDir: string;
let db: Registry;
let user: User;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-sessions-"));
  db = openRegistry(dataDir);
  user = insertUser(db, { username: "admin", passwordHash: "unused" });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("sessions", () => {
  it("issues a 32-byte base64url token and stores only its SHA-256", () => {
    const token = createSession(db, user.id);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(getSession(db, token)).toBeUndefined();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    expect(getSession(db, tokenHash)).toMatchObject({ userId: user.id });
  });

  it("resolves a fresh token to its user", () => {
    const token = createSession(db, user.id);
    expect(resolveSession(db, token)?.user).toMatchObject({ id: user.id, username: "admin" });
  });

  it("expires after seven days and deletes the row", () => {
    const issuedAt = new Date("2026-10-01T00:00:00.000Z");
    const token = createSession(db, user.id, issuedAt);
    expect(resolveSession(db, token, new Date(issuedAt.getTime() + 7 * DAY - 1))).toBeDefined();
    expect(resolveSession(db, token, new Date(issuedAt.getTime() + 7 * DAY))).toBeUndefined();
    expect(resolveSession(db, token, issuedAt)).toBeUndefined();
  });

  it("rejects an unknown token", () => {
    expect(resolveSession(db, "not-a-session")).toBeUndefined();
  });

  it("ends a session", () => {
    const token = createSession(db, user.id);
    const session = resolveSession(db, token);
    if (!session) throw new Error("expected a session");
    endSession(db, session.tokenHash);
    expect(resolveSession(db, token)).toBeUndefined();
  });
});
