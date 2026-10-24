import type pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dropPoolerRole,
  installPoolerRole,
  POOLER_AUTH_QUERY,
  poolerRoleFor,
} from "../../src/pooler/role.js";

const PASSWORD = "plain-pooler-password";
const ROLE = poolerRoleFor("hattisar-b1");

let sql: string[];
let params: unknown[][];
let roleExists: boolean;
let schemaExists: boolean;

const fakeClient = {
  query: async (text: string, values: unknown[] = []) => {
    sql.push(text);
    params.push(values);
    if (text.startsWith("select 1 from pg_roles")) {
      return roleExists ? { rowCount: 1, rows: [{ "?column?": 1 }] } : { rowCount: 0, rows: [] };
    }
    if (text.startsWith("select 1 from pg_namespace")) {
      return schemaExists ? { rowCount: 1, rows: [{ "?column?": 1 }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  },
} as unknown as pg.Client;

beforeEach(() => {
  sql = [];
  params = [];
  roleExists = false;
  schemaExists = false;
});

describe("poolerRoleFor", () => {
  it("derives a stable role from the tenant id's sha256", () => {
    expect(poolerRoleFor("hattisar-b1")).toBe("hattisar_pooler_0f7b62bfffbe");
    expect(poolerRoleFor("hattisar-b1")).toHaveLength(28);
    expect(poolerRoleFor("hattisar-b1")).toBe(poolerRoleFor("hattisar-b1"));
  });

  it("gives each tenant its own role", () => {
    expect(poolerRoleFor("hattisar-b2")).not.toBe(poolerRoleFor("hattisar-b1"));
  });
});

describe("installPoolerRole", () => {
  it("names the auth query Supavisor uses", () => {
    expect(POOLER_AUTH_QUERY).toBe("SELECT * FROM hattisar_pooler.get_auth($1)");
  });

  it("creates the role with a SCRAM verifier when it is missing", async () => {
    await installPoolerRole(fakeClient, ROLE, PASSWORD);

    expect(sql[0]).toBe("select 1 from pg_roles where rolname = $1");
    expect(params[0]).toEqual([ROLE]);
    const create = sql.find((text) => text.startsWith("CREATE ROLE"));
    expect(create).toContain(`CREATE ROLE "${ROLE}" LOGIN PASSWORD 'SCRAM-SHA-256$4096:`);
    expect(sql.some((text) => text.startsWith("ALTER ROLE"))).toBe(false);
  });

  it("alters the role with a SCRAM verifier when it exists", async () => {
    roleExists = true;
    await installPoolerRole(fakeClient, ROLE, PASSWORD);

    const alter = sql.find((text) => text.startsWith("ALTER ROLE"));
    expect(alter).toContain(`ALTER ROLE "${ROLE}" LOGIN PASSWORD 'SCRAM-SHA-256$4096:`);
    expect(sql.some((text) => text.startsWith("CREATE ROLE"))).toBe(false);
  });

  it("never sends the plaintext password", async () => {
    await installPoolerRole(fakeClient, ROLE, PASSWORD);
    roleExists = true;
    await installPoolerRole(fakeClient, ROLE, PASSWORD);

    expect(JSON.stringify({ sql, params })).not.toContain(PASSWORD);
  });

  it("installs a SECURITY DEFINER auth function over pg_authid", async () => {
    await installPoolerRole(fakeClient, ROLE, PASSWORD);

    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS hattisar_pooler");
    const fn = sql.find((text) => text.startsWith("CREATE OR REPLACE FUNCTION"));
    expect(fn).toContain("CREATE OR REPLACE FUNCTION hattisar_pooler.get_auth(p_usename text)");
    expect(fn).toContain("RETURNS TABLE(username text, password text)");
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("SET search_path = ''");
    expect(fn).toContain("pg_catalog.pg_authid");
    expect(fn).toContain("rolcanlogin");
    expect(fn).toContain("NOT rolsuper");
    expect(fn).toContain("rolvaliduntil");
  });

  it("lets only the tenant's role run the auth function", async () => {
    await installPoolerRole(fakeClient, ROLE, PASSWORD);

    expect(sql).toContain("REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC");
    expect(sql).toContain(`GRANT USAGE ON SCHEMA hattisar_pooler TO "${ROLE}"`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION hattisar_pooler.get_auth(text) TO "${ROLE}"`);
    expect(
      sql.indexOf("REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC"),
    ).toBeGreaterThan(sql.findIndex((text) => text.startsWith("CREATE OR REPLACE FUNCTION")));
  });
});

describe("dropPoolerRole", () => {
  it("does nothing when the role is missing", async () => {
    await dropPoolerRole(fakeClient, ROLE);

    expect(sql).toEqual(["select 1 from pg_roles where rolname = $1"]);
    expect(params[0]).toEqual([ROLE]);
  });

  it("revokes the role's grants, then drops it", async () => {
    roleExists = true;
    await dropPoolerRole(fakeClient, ROLE);

    expect(sql.slice(1)).toEqual([
      "select 1 from pg_namespace where nspname = 'hattisar_pooler'",
      `DROP ROLE IF EXISTS "${ROLE}"`,
    ]);
  });

  it("revokes the grants on the auth schema and function when the schema exists", async () => {
    roleExists = true;
    schemaExists = true;
    await dropPoolerRole(fakeClient, ROLE);

    expect(sql.slice(2)).toEqual([
      `REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM "${ROLE}"`,
      `REVOKE USAGE ON SCHEMA hattisar_pooler FROM "${ROLE}"`,
      `DROP ROLE IF EXISTS "${ROLE}"`,
    ]);
  });

  it("escapes the role name", async () => {
    roleExists = true;
    await dropPoolerRole(fakeClient, 'odd"role');
    expect(sql).toContain('DROP ROLE IF EXISTS "odd""role"');
  });
});
