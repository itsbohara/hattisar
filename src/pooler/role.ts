import pg from "pg";
import { scramVerifier } from "../projects/owner-password.js";

export const POOLER_ROLE = "hattisar_pooler";
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

export async function installPoolerRole(client: pg.Client, password: string): Promise<void> {
  const role = pg.escapeIdentifier(POOLER_ROLE);
  const exists = await client.query("select 1 from pg_roles where rolname = $1", [POOLER_ROLE]);
  const verb = exists.rowCount === 0 ? "CREATE" : "ALTER";
  await client.query(
    `${verb} ROLE ${role} LOGIN PASSWORD ${pg.escapeLiteral(scramVerifier(password))}`,
  );
  await client.query("CREATE SCHEMA IF NOT EXISTS hattisar_pooler");
  await client.query(GET_AUTH);
  await client.query("REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC");
  await client.query(`GRANT USAGE ON SCHEMA hattisar_pooler TO ${role}`);
  await client.query(`GRANT EXECUTE ON FUNCTION hattisar_pooler.get_auth(text) TO ${role}`);
}
