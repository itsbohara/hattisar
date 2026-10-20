import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Registry = Database.Database;

// The build copies this directory next to the compiled db.js (see the package.json build script).
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const MIGRATION_FILE = /^(\d+)_[a-z0-9_]+\.sql$/;

export function openRegistry(dataDir: string): Registry {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "hattisar.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: Registry, dir: string = MIGRATIONS_DIR): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version),
  );
  const record = db.prepare<[number, string, string]>(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const { version, name } of listMigrations(dir)) {
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(version, name, new Date().toISOString());
    })();
  }
}

function listMigrations(dir: string): { version: number; name: string }[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const match = MIGRATION_FILE.exec(name);
      return match ? [{ version: Number(match[1]), name }] : [];
    })
    .sort((a, b) => a.version - b.version);
}
