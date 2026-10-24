import type pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { installPoolerRole, POOLER_AUTH_QUERY, POOLER_ROLE } from "../../src/pooler/role.js";

const PASSWORD = "plain-pooler-password";

let sql: string[];
let params: unknown[][];
let roleExists: boolean;

const fakeClient = {
  query: async (text: string, values: unknown[] = []) => {
    sql.push(text);
    params.push(values);
    if (text.startsWith("select 1 from pg_roles")) {
      return roleExists ? { rowCount: 1, rows: [{ "?column?": 1 }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  },
} as unknown as pg.Client;

beforeEach(() => {
  sql = [];
  params = [];
  roleExists = false;
});

describe("installPoolerRole", () => {
  it("names the role and auth query Supavisor uses", () => {
    expect(POOLER_ROLE).toBe("hattisar_pooler");
    expect(POOLER_AUTH_QUERY).toBe("SELECT * FROM hattisar_pooler.get_auth($1)");
  });

  it("creates the role with a SCRAM verifier when it is missing", async () => {
    await installPoolerRole(fakeClient, PASSWORD);

    expect(sql[0]).toBe("select 1 from pg_roles where rolname = $1");
    expect(params[0]).toEqual(["hattisar_pooler"]);
    const create = sql.find((text) => text.startsWith("CREATE ROLE"));
    expect(create).toContain(`CREATE ROLE "hattisar_pooler" LOGIN PASSWORD 'SCRAM-SHA-256$4096:`);
    expect(sql.some((text) => text.startsWith("ALTER ROLE"))).toBe(false);
  });

  it("alters the role with a SCRAM verifier when it exists", async () => {
    roleExists = true;
    await installPoolerRole(fakeClient, PASSWORD);

    const alter = sql.find((text) => text.startsWith("ALTER ROLE"));
    expect(alter).toContain(`ALTER ROLE "hattisar_pooler" LOGIN PASSWORD 'SCRAM-SHA-256$4096:`);
    expect(sql.some((text) => text.startsWith("CREATE ROLE"))).toBe(false);
  });

  it("never sends the plaintext password", async () => {
    await installPoolerRole(fakeClient, PASSWORD);
    roleExists = true;
    await installPoolerRole(fakeClient, PASSWORD);

    expect(JSON.stringify({ sql, params })).not.toContain(PASSWORD);
  });

  it("installs a SECURITY DEFINER auth function over pg_authid", async () => {
    await installPoolerRole(fakeClient, PASSWORD);

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

  it("lets only hattisar_pooler run the auth function", async () => {
    await installPoolerRole(fakeClient, PASSWORD);

    expect(sql).toContain("REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC");
    expect(sql).toContain('GRANT USAGE ON SCHEMA hattisar_pooler TO "hattisar_pooler"');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION hattisar_pooler.get_auth(text) TO "hattisar_pooler"',
    );
    expect(
      sql.indexOf("REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC"),
    ).toBeGreaterThan(sql.findIndex((text) => text.startsWith("CREATE OR REPLACE FUNCTION")));
  });
});
