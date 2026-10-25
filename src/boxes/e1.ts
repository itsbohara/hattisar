import { type BoxConnection, safeErrorMessage, withAdminClient } from "./admin-client.js";

export const REQUIRED_EXTENSIONS = ["pgcrypto", "uuid-ossp", "pg_stat_statements"];
const MIN_SERVER_VERSION_NUM = 150000;
// Exclusive: the bundled pg_dump 18 refuses to dump a newer server.
const MAX_SERVER_VERSION_NUM = 190000;

export interface E1Result {
  ok: boolean;
  problems: string[];
}

export interface E1Facts {
  serverVersionNum: number;
  availableExtensions: string[];
  adminUser: string;
  superuser: boolean;
}

export function e1Problems(facts: E1Facts): string[] {
  const problems: string[] = [];
  const major = Math.floor(facts.serverVersionNum / 10000);
  if (facts.serverVersionNum < MIN_SERVER_VERSION_NUM) {
    problems.push(`Postgres 15 or newer is required; this server is version ${major}`);
  }
  if (facts.serverVersionNum >= MAX_SERVER_VERSION_NUM) {
    problems.push(`Postgres 18 or older is required; this server is version ${major}`);
  }
  for (const extension of REQUIRED_EXTENSIONS) {
    if (!facts.availableExtensions.includes(extension)) {
      problems.push(`Extension not available: ${extension}`);
    }
  }
  if (!facts.superuser) problems.push(`Admin user ${facts.adminUser} is not a superuser`);
  return problems;
}

async function readFacts(conn: BoxConnection): Promise<E1Facts> {
  return withAdminClient(conn, async (client) => {
    const admin = await client.query<{ version: string; rolsuper: boolean }>(
      `select current_setting('server_version_num') as version, rolsuper
         from pg_roles where rolname = current_user`,
    );
    const extensions = await client.query<{ name: string }>(
      "select name from pg_available_extensions where name = any($1::text[])",
      [REQUIRED_EXTENSIONS],
    );
    const row = admin.rows[0];
    return {
      serverVersionNum: Number(row?.version ?? 0),
      availableExtensions: extensions.rows.map((r) => r.name),
      adminUser: conn.user,
      superuser: row?.rolsuper ?? false,
    };
  });
}

export async function checkBox(conn: BoxConnection): Promise<E1Result> {
  let facts: E1Facts;
  try {
    facts = await readFacts(conn);
  } catch (error) {
    return { ok: false, problems: [`cannot connect: ${safeErrorMessage(error, conn.password)}`] };
  }
  const problems = e1Problems(facts);
  return { ok: problems.length === 0, problems };
}
