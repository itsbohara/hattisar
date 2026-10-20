import { type BoxConnection, safeErrorMessage, withAdminClient } from "./admin-client.js";

export const REQUIRED_ROLES = ["supabase_admin", "anon", "authenticated", "service_role"];
export const REQUIRED_EXTENSIONS = ["pgcrypto", "uuid-ossp", "pg_stat_statements"];
const MIN_SERVER_VERSION_NUM = 150000;

export interface E1Result {
  ok: boolean;
  problems: string[];
}

export interface E1Facts {
  serverVersionNum: number;
  roles: string[];
  availableExtensions: string[];
  adminUser: string;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
}

export function e1Problems(facts: E1Facts): string[] {
  const problems: string[] = [];
  if (facts.serverVersionNum < MIN_SERVER_VERSION_NUM) {
    const major = Math.floor(facts.serverVersionNum / 10000);
    problems.push(`Postgres 15 or newer is required; this server is version ${major}`);
  }
  for (const role of REQUIRED_ROLES) {
    if (!facts.roles.includes(role)) problems.push(`Missing role: ${role}`);
  }
  for (const extension of REQUIRED_EXTENSIONS) {
    if (!facts.availableExtensions.includes(extension)) {
      problems.push(`Extension not available: ${extension}`);
    }
  }
  if (!facts.superuser && !(facts.createdb && facts.createrole)) {
    problems.push(
      `Admin user ${facts.adminUser} is not a superuser and lacks CREATEDB and CREATEROLE`,
    );
  }
  return problems;
}

async function readFacts(conn: BoxConnection): Promise<E1Facts> {
  return withAdminClient(conn, async (client) => {
    const admin = await client.query<{
      version: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `select current_setting('server_version_num') as version, rolsuper, rolcreatedb, rolcreaterole
         from pg_roles where rolname = current_user`,
    );
    const roles = await client.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname = any($1::text[])",
      [REQUIRED_ROLES],
    );
    const extensions = await client.query<{ name: string }>(
      "select name from pg_available_extensions where name = any($1::text[])",
      [REQUIRED_EXTENSIONS],
    );
    const row = admin.rows[0];
    return {
      serverVersionNum: Number(row?.version ?? 0),
      roles: roles.rows.map((r) => r.rolname),
      availableExtensions: extensions.rows.map((r) => r.name),
      adminUser: conn.user,
      superuser: row?.rolsuper ?? false,
      createdb: row?.rolcreatedb ?? false,
      createrole: row?.rolcreaterole ?? false,
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
