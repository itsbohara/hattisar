import { ConfigError } from "../config.js";
import type { Registry } from "../registry/db.js";
import { countUsers, insertUser } from "../registry/users.js";
import { hashPassword } from "./password.js";

export async function seedAdmin(
  db: Registry,
  { adminUsername, adminPassword }: { adminUsername: string; adminPassword: string | undefined },
): Promise<void> {
  if (countUsers(db) > 0) return;
  if (adminPassword === undefined) {
    throw new ConfigError("HATTISAR_ADMIN_PASSWORD is required on first boot (no users exist yet)");
  }
  insertUser(db, { username: adminUsername, passwordHash: await hashPassword(adminPassword) });
}
