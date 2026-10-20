import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../../src/auth/password.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { ConfigError } from "../../src/config.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { countUsers, getUserByUsername } from "../../src/registry/users.js";

let dataDir: string;
let db: Registry;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-seed-"));
  db = openRegistry(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("first-boot admin seeding", () => {
  it("creates the admin from the environment when no users exist", async () => {
    await seedAdmin(db, { adminUsername: "root", adminPassword: "first-boot-password" });
    const user = getUserByUsername(db, "root");
    expect(user).toBeDefined();
    expect(await verifyPassword("first-boot-password", user?.passwordHash ?? "")).toBe(true);
  });

  it("seeds only once and ignores the env password afterwards", async () => {
    await seedAdmin(db, { adminUsername: "admin", adminPassword: "first-boot-password" });
    await seedAdmin(db, { adminUsername: "admin", adminPassword: "a-different-password" });
    await seedAdmin(db, { adminUsername: "other", adminPassword: undefined });
    expect(countUsers(db)).toBe(1);
    const user = getUserByUsername(db, "admin");
    expect(await verifyPassword("first-boot-password", user?.passwordHash ?? "")).toBe(true);
  });

  it("fails boot naming the variable when no users exist and no password is set", async () => {
    const seeding = seedAdmin(db, { adminUsername: "admin", adminPassword: undefined });
    await expect(seeding).rejects.toBeInstanceOf(ConfigError);
    await expect(seeding).rejects.toThrow(/HATTISAR_ADMIN_PASSWORD/);
    expect(countUsers(db)).toBe(0);
  });
});
