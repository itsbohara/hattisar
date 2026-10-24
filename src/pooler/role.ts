import { createHmac } from "node:crypto";
import pg from "pg";
import { scramVerifier } from "../projects/owner-password.js";

export const POOLER_AUTH_QUERY = "SELECT * FROM hattisar_pooler.get_auth($1)";

// Owned by the connecting admin, a superuser (E1), so SECURITY DEFINER can read pg_authid.
// NOT rolsuper keeps superuser secrets out of the pooler's reach.
const GET_AUTH = `CREATE OR REPLACE FUNCTION hattisar_pooler.get_auth(p_usename text)
RETURNS TABLE(username text, password text)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  SELECT rolname::text,
         CASE WHEN rolvaliduntil < pg_catalog.now() THEN NULL ELSE rolpassword::text END
  FROM pg_catalog.pg_authid
  WHERE rolname = p_usename AND rolcanlogin AND NOT rolsuper
$$`;

// One role per tenant: boxes sharing a server would otherwise reset each other's manager password.
// Keyed by the install's secret because two installs can derive the same tenant id.
export function poolerRoleFor(secretKey: Buffer, tenantId: string): string {
  const digest = createHmac("sha256", secretKey).update(tenantId).digest("hex");
  return `hattisar_pooler_${digest.slice(0, 12)}`;
}

async function roleExists(client: pg.Client, role: string): Promise<boolean> {
  const result = await client.query("select 1 from pg_roles where rolname = $1", [role]);
  return result.rowCount !== 0;
}

export async function installPoolerRole(
  client: pg.Client,
  roleName: string,
  password: string,
): Promise<void> {
  const role = pg.escapeIdentifier(roleName);
  const verb = (await roleExists(client, roleName)) ? "ALTER" : "CREATE";
  await client.query(
    `${verb} ROLE ${role} LOGIN PASSWORD ${pg.escapeLiteral(scramVerifier(password))}`,
  );
  await client.query("CREATE SCHEMA IF NOT EXISTS hattisar_pooler");
  await client.query(GET_AUTH);
  await client.query("REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC");
  await client.query(`GRANT USAGE ON SCHEMA hattisar_pooler TO ${role}`);
  await client.query(`GRANT EXECUTE ON FUNCTION hattisar_pooler.get_auth(text) TO ${role}`);
}

// The schema and function stay: other tenants on this server may use them.
export async function dropPoolerRole(client: pg.Client, roleName: string): Promise<void> {
  if (!(await roleExists(client, roleName))) return;
  const role = pg.escapeIdentifier(roleName);
  const schema = await client.query("select 1 from pg_namespace where nspname = 'hattisar_pooler'");
  if (schema.rowCount !== 0) {
    await client.query(`REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM ${role}`);
    await client.query(`REVOKE USAGE ON SCHEMA hattisar_pooler FROM ${role}`);
  }
  await client.query(`DROP ROLE IF EXISTS ${role}`);
}
