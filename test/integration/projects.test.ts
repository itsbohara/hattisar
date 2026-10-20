import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionStrings,
  createProject,
  dropProject,
  fetchWith,
  sharedBoxId,
} from "../helpers/projects.js";
import { postForm, signIn } from "../helpers/session.js";
import { sharedBoxSql } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const suffix = randomUUID().slice(0, 8);
const refA = `it-a-${suffix}`;
const refB = `it-b-${suffix}`;
const created: string[] = [];
let cookie: string;
let boxId: string;

function dbName(ref: string): string {
  return ref.replaceAll("-", "_");
}

function ownerRole(ref: string): string {
  return `hs_${dbName(ref)}_owner`;
}

async function create(ref: string, name = ref): Promise<Response> {
  const response = await createProject(baseUrl, cookie, { ref, name, boxId });
  if (response.status === 302) created.push(ref);
  return response;
}

// Session and transaction strings, in the order the project page lists them.
async function poolerStrings(ref: string): Promise<{ session: string; transaction: string }> {
  const [session, transaction, ...rest] = await connectionStrings(baseUrl, cookie, ref);
  if (!session || !transaction || rest.length > 0) throw new Error(`${ref}: expected two strings`);
  return { session, transaction };
}

async function withClient<T>(
  connectionString: string,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function connectError(connectionString: string): Promise<string> {
  try {
    await withClient(connectionString, async () => undefined);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("connected, but expected the connection to be refused");
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function inspect(ref: string): Record<string, unknown> {
  const script = `
    SELECT json_build_object(
      'owner', (SELECT datdba::regrole::text FROM pg_database WHERE datname = :'db'),
      'publicCanConnect', has_database_privilege('public', :'db', 'CONNECT'),
      'ownerCanConnect', has_database_privilege(:'role', :'db', 'CONNECT'),
      'searchPath', (SELECT setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
                     WHERE d.datname = :'db' AND s.setrole = 0),
      'extensions', (SELECT json_object_agg(extname, extnamespace::regnamespace::text)
                     FROM pg_extension WHERE extname IN ('pgcrypto', 'uuid-ossp', 'pg_stat_statements')),
      'publicOwner', (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public'),
      'ownerUsesExtensions', has_schema_privilege(:'role', 'extensions', 'USAGE')
    );`;
  return JSON.parse(sharedBoxSql(script, { db: dbName(ref), role: ownerRole(ref) }, dbName(ref)));
}

function roleExists(role: string): boolean {
  return (
    sharedBoxSql("SELECT count(*) FROM pg_roles WHERE rolname = :'role'", { role }).trim() === "1"
  );
}

function databaseExists(db: string): boolean {
  return (
    sharedBoxSql("SELECT count(*) FROM pg_database WHERE datname = :'db'", { db }).trim() === "1"
  );
}

beforeAll(async () => {
  cookie = await signIn(baseUrl);
  boxId = await sharedBoxId(baseUrl, cookie);
}, 60_000);

afterAll(() => {
  for (const ref of created) dropProject(ref);
});

describe("projects on the shared box", () => {
  it("creates the database and owner role with the baseline applied", async () => {
    const response = await create(refA, "Integration A");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/_hs/projects/${refA}`);

    expect(inspect(refA)).toEqual({
      owner: ownerRole(refA),
      publicCanConnect: false,
      ownerCanConnect: true,
      searchPath: ['search_path="$user", public, extensions'],
      extensions: {
        pgcrypto: "extensions",
        "uuid-ossp": "extensions",
        pg_stat_statements: "extensions",
      },
      publicOwner: ownerRole(refA),
      ownerUsesExtensions: true,
    });
  });

  it.each(["session", "transaction"] as const)(
    "lets the owner connect through the pooler's %s port and create a table",
    async (mode) => {
      const strings = await poolerStrings(refA);
      const rows = await withClient(strings[mode], async (client) => {
        await client.query(
          `create table if not exists ${mode}_items (id uuid default gen_random_uuid())`,
        );
        await client.query(`insert into ${mode}_items default values`);
        return (await client.query("select current_user, current_database()")).rows;
      });
      expect(rows).toEqual([{ current_user: ownerRole(refA), current_database: dbName(refA) }]);
    },
  );

  it("keeps each owner out of every other project's database", async () => {
    expect((await create(refB)).status).toBe(302);
    const a = await poolerStrings(refA);
    const b = await poolerStrings(refB);
    expect(await connectError(withDatabase(a.session, dbName(refB)))).toMatch(/permission denied/);
    expect(await connectError(withDatabase(b.transaction, dbName(refA)))).toMatch(
      /permission denied/,
    );
  });

  it("rejects a duplicate ref", async () => {
    const response = await create(refA, "Again");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`Ref ${refA} is already taken`);
  });

  it.each(["UPPER", "1abc", "ab", "a_b_c", "new"])("rejects the invalid ref %s", async (ref) => {
    const response = await create(ref);
    expect(response.status).toBe(400);
    expect(databaseExists(ref.replaceAll("-", "_").toLowerCase())).toBe(false);
  });

  it("leaves no database, role or row behind when the create fails part-way", async () => {
    const ref = `it-fail-${suffix}`;
    const role = ownerRole(ref);
    sharedBoxSql('CREATE ROLE :"role" NOLOGIN', { role });
    try {
      const response = await create(ref);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("already exists");
      expect(databaseExists(dbName(ref))).toBe(false);
      expect((await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}`)).status).toBe(404);
      const listed = await (await fetchWith(baseUrl, cookie, "/api/platform/projects")).json();
      expect(listed).not.toContainEqual(expect.objectContaining({ ref }));
      // The role was not hattisar's to drop.
      expect(roleExists(role)).toBe(true);
    } finally {
      sharedBoxSql('DROP ROLE IF EXISTS :"role"', { role });
    }
  });

  it("rotates the owner password: the old one stops working, the new one works", async () => {
    const before = await poolerStrings(refA);
    await withClient(before.session, async () => undefined);
    const response = await postForm(baseUrl, `/_hs/projects/${refA}/rotate`, {}, cookie);
    expect(response.status).toBe(302);
    const after = await poolerStrings(refA);
    expect(after.session).not.toBe(before.session);

    for (const mode of ["session", "transaction"] as const) {
      expect(await connectError(before[mode])).toMatch(/password authentication failed/);
      const rows = await withClient(
        after[mode],
        async (client) => (await client.query("select 1 as ok")).rows,
      );
      expect(rows).toEqual([{ ok: 1 }]);
    }
  });

  it("renames the display name everywhere it is shown", async () => {
    const response = await postForm(
      baseUrl,
      `/_hs/projects/${refA}/name`,
      { name: "Renamed A" },
      cookie,
    );
    expect(response.status).toBe(302);
    const listed = await (await fetchWith(baseUrl, cookie, "/api/platform/projects")).json();
    expect(listed).toContainEqual(expect.objectContaining({ ref: refA, name: "Renamed A" }));
    expect(await (await fetchWith(baseUrl, cookie, "/_hs/projects")).text()).toContain("Renamed A");
  });
});
