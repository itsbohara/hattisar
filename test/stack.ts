import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFiles = [
  "docker/compose.yml",
  "docker/compose.dev.yml",
  "test/compose.test.yml",
].flatMap((file) => ["-f", file]);

export function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...composeFiles, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
}

// Recreates hattisar with the test override (debug log on) and waits for it.
export function startTestStack(): void {
  compose(["up", "-d", "--wait", "hattisar"]);
}

export function stackEnv(): Record<string, string | null | undefined> {
  const config = JSON.parse(compose(["config", "--format", "json"])) as {
    services: { hattisar: { environment: Record<string, string | null | undefined> } };
  };
  return config.services.hattisar.environment;
}

// As the shared box's admin; psql variables keep identifiers and literals out of the script text.
export function sharedBoxSql(
  script: string,
  vars: Record<string, string> = {},
  db = "postgres",
): string {
  const varArgs = Object.entries(vars).flatMap(([name, value]) => ["-v", `${name}=${value}`]);
  return compose(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      db,
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      ...varArgs,
    ],
    script,
  );
}

// For registry state hattisar has no endpoint for yet.
export function registrySql(sql: string, ...params: (string | number)[]): void {
  const script = `
    const Database = require("better-sqlite3");
    const db = new Database("/data/hattisar.db");
    db.pragma("foreign_keys = ON");
    db.prepare(process.argv[1]).run(...JSON.parse(process.argv[2]));
  `;
  compose(["exec", "-T", "hattisar", "node", "-e", script, sql, JSON.stringify(params)]);
}

export function dbLogSince(since: string): string {
  return compose(["logs", "db", "--since", since, "--no-log-prefix"]);
}
