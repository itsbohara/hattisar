import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFiles = [
  "docker/compose.yml",
  "docker/compose.dev.yml",
  "test/compose.spike.yml",
].flatMap((file) => ["-f", file]);

export function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...composeFiles, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
}

function createSpikeDatabase(database: string, table: string): void {
  const script = `
    select format('create database %I', :'db')
      where not exists (select 1 from pg_database where datname = :'db') \\gexec
    \\c :"db"
    select format('create table if not exists public.%I (id int primary key)', :'tbl') \\gexec
  `;
  compose(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `db=${database}`,
      "-v",
      `tbl=${table}`,
    ],
    script,
  );
}

// Two projects on the shared box: spike-a (db spike_a, table alpha), spike-b (db spike_b, table beta).
export function prepareSpikeStack(): void {
  createSpikeDatabase("spike_a", "alpha");
  createSpikeDatabase("spike_b", "beta");
  compose(["up", "-d", "--wait", "hattisar"]);
}

export function dbLogSince(since: string): string {
  return compose(["logs", "db", "--since", since, "--no-log-prefix"]);
}
