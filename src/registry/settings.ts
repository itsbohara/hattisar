import type { Registry } from "./db.js";

// Values are stored as given: callers encrypt secret settings (e.g. the S3 secret) themselves.
export function getSetting(db: Registry, key: string): string | undefined {
  return db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(key)?.value;
}

export function setSetting(db: Registry, key: string, value: string): void {
  db.prepare<[string, string]>(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteSetting(db: Registry, key: string): void {
  db.prepare<[string]>("DELETE FROM settings WHERE key = ?").run(key);
}
