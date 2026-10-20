import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openRegistry, type Registry } from "../../src/registry/db.js";

const TABLES = [
  "backup_schedules",
  "backups",
  "boxes",
  "projects",
  "schema_migrations",
  "sessions",
  "settings",
  "users",
];

let dataDir: string;
let db: Registry | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-registry-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

function tables(registry: Registry): string[] {
  return registry
    .prepare<[], string>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all();
}

function migrationCount(registry: Registry): number {
  return registry.prepare<[], number>("SELECT count(*) FROM schema_migrations").pluck().get() ?? 0;
}

describe("openRegistry", () => {
  it("creates hattisar.db in the data dir with every §4 table", () => {
    db = openRegistry(join(dataDir, "nested"));
    expect(db.name).toBe(join(dataDir, "nested", "hattisar.db"));
    expect(tables(db)).toEqual(TABLES);
  });

  it("enables WAL and foreign keys", () => {
    db = openRegistry(dataDir);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is idempotent across migrate calls and reopens", () => {
    db = openRegistry(dataDir);
    db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    const applied = migrationCount(db);
    expect(applied).toBeGreaterThan(0);

    migrate(db);
    expect(migrationCount(db)).toBe(applied);
    db.close();

    db = openRegistry(dataDir);
    expect(migrationCount(db)).toBe(applied);
    expect(tables(db)).toEqual(TABLES);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'k'").pluck().get()).toBe("v");
  });
});

describe("migrate", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(dataDir, "migrations");
    mkdirSync(dir);
    db = openRegistry(dataDir);
  });

  function run(): void {
    migrate(db as Registry, dir);
  }

  it("applies pending migrations once each, in numeric order, ignoring other files", () => {
    writeFileSync(join(dir, "101_first.sql"), "CREATE TABLE log (step TEXT NOT NULL);");
    writeFileSync(join(dir, "README.md"), "not a migration");
    run();
    writeFileSync(join(dir, "102_second.sql"), "INSERT INTO log (step) VALUES ('second');");
    writeFileSync(join(dir, "0110_third.sql"), "INSERT INTO log (step) VALUES ('third');");
    run();
    run();
    expect(db?.prepare("SELECT step FROM log").pluck().all()).toEqual(["second", "third"]);
  });

  it("rolls back a failing migration entirely", () => {
    writeFileSync(
      join(dir, "900_broken.sql"),
      "CREATE TABLE half_done (id INTEGER); INSERT INTO missing_table VALUES (1);",
    );
    const applied = migrationCount(db as Registry);
    expect(run).toThrow();
    expect(tables(db as Registry)).not.toContain("half_done");
    expect(migrationCount(db as Registry)).toBe(applied);
  });
});
