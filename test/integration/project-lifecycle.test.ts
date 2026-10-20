import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionStrings,
  createProject,
  dropProject,
  fetchWith,
  postQuery,
  sharedBoxId,
} from "../helpers/projects.js";
import { postForm, signIn } from "../helpers/session.js";
import { compose, sharedBoxSql } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const ref = `it-life-${randomUUID().slice(0, 8)}`;
const dbName = ref.replaceAll("-", "_");
const ownerRole = `hs_${dbName}_owner`;
let cookie: string;
let boxId: string;

async function poolerStrings(): Promise<{ session: string; transaction: string }> {
  const [session, transaction] = await connectionStrings(baseUrl, cookie, ref);
  if (!session || !transaction) throw new Error(`${ref}: expected two connection strings`);
  return { session, transaction };
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function notes(url: string): Promise<string[]> {
  return withClient(url, async (client) =>
    (await client.query<{ body: string }>("select body from notes order by body")).rows.map(
      (row) => row.body,
    ),
  );
}

// One locked-out pooler login only: after that Supavisor's auth query no longer finds the role, and
// those failures open its circuit breakers (keyed by tenant, and by client IP), which would then
// refuse every project's pooler logins from this host, other test files' included.
async function poolerError(url: string): Promise<string> {
  try {
    await notes(url);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the pooler let the owner of a deleted project in");
}

// The box port is not published, so the owner's direct login is tried from inside the compose
// network. The password travels on stdin, never in argv.
function directLogin(password: string): string {
  const script = `
    const pg = require("pg");
    const { user, password, database } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const client = new pg.Client({ host: "db", port: 5432, user, password, database, ssl: false });
    client.connect()
      .then(() => client.query("select count(*) from notes"))
      .then((r) => { console.log("ok " + r.rows[0].count); return client.end(); })
      .catch((e) => console.log("refused " + e.message));
  `;
  return compose(
    ["exec", "-T", "-w", "/app", "hattisar", "node", "-e", script],
    JSON.stringify({ user: ownerRole, password, database: dbName }),
  ).trim();
}

function ownerPassword(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

function databases(): string[] {
  return sharedBoxSql(
    "SELECT datname FROM pg_database WHERE datname = :'db' OR starts_with(datname, :'db' || '__deleted_') ORDER BY 1",
    { db: dbName },
  )
    .split("\n")
    .filter((line) => line !== "");
}

function roleLogin(): string {
  return sharedBoxSql("SELECT rolcanlogin FROM pg_roles WHERE rolname = :'role'", {
    role: ownerRole,
  }).trim();
}

async function studioListed(): Promise<boolean> {
  const listed = (await (await fetchWith(baseUrl, cookie, "/api/platform/projects")).json()) as {
    ref: string;
  }[];
  return listed.some((project) => project.ref === ref);
}

function today(): string {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

beforeAll(async () => {
  cookie = await signIn(baseUrl);
  boxId = await sharedBoxId(baseUrl, cookie);
  const created = await createProject(baseUrl, cookie, { ref, name: "Lifecycle", boxId });
  expect(created.status).toBe(302);
  const { session } = await poolerStrings();
  await withClient(session, async (client) => {
    await client.query("create table notes (body text)");
    await client.query("insert into notes values ('kept')");
  });
}, 60_000);

afterAll(() => {
  dropProject(ref);
});

describe("soft delete, restore and purge on the shared box", () => {
  let strings: { session: string; transaction: string };

  it("refuses to delete unless the ref is typed", async () => {
    strings = await poolerStrings();
    const response = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/delete`,
      { confirm: "nope" },
      cookie,
    );
    expect(response.status).toBe(400);
    expect(databases()).toEqual([dbName]);
  });

  it("soft-deletes: database renamed, owner locked out, hidden from Studio, ref reserved", async () => {
    const response = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/delete`,
      { confirm: ref },
      cookie,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/trash");

    expect(databases()).toEqual([`${dbName}__deleted_${today()}`]);
    expect(roleLogin()).toBe("f");

    expect(await poolerError(strings.session)).toMatch(/is not permitted to log in/);
    expect(directLogin(ownerPassword(strings.session))).toMatch(
      /^refused .*not permitted to log in/,
    );

    expect(await studioListed()).toBe(false);
    expect((await fetchWith(baseUrl, cookie, `/api/platform/projects/${ref}`)).status).toBe(404);
    expect((await postQuery(baseUrl, cookie, ref, "select 1")).status).toBe(404);
    const studioPage = await fetchWith(baseUrl, cookie, `/project/${ref}/editor`);
    expect(studioPage.status).toBe(302);
    expect(studioPage.headers.get("location")).toBe("/_hs/projects");
    expect((await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}`)).status).toBe(404);

    const again = await createProject(baseUrl, cookie, { ref, name: "Again", boxId });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain(`Ref ${ref} is already taken`);

    const trash = await (await fetchWith(baseUrl, cookie, "/_hs/trash")).text();
    expect(trash).toContain(`data-project="${ref}"`);
  });

  it("restores everything, data included", async () => {
    const response = await postForm(baseUrl, `/_hs/trash/${ref}/restore`, {}, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/_hs/projects/${ref}`);

    expect(databases()).toEqual([dbName]);
    expect(roleLogin()).toBe("t");
    expect(await notes(strings.session)).toEqual(["kept"]);
    expect(await notes(strings.transaction)).toEqual(["kept"]);
    expect(directLogin(ownerPassword(strings.session))).toBe("ok 1");

    expect(await studioListed()).toBe(true);
    const query = await postQuery(baseUrl, cookie, ref, "select body from notes");
    expect(query.status).toBe(200);
    expect(await query.json()).toEqual([{ body: "kept" }]);
  });

  it("drops nothing while the owner role holds privileges outside its database", async () => {
    const deleted = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/delete`,
      { confirm: ref },
      cookie,
    );
    expect(deleted.status).toBe(302);
    sharedBoxSql('GRANT CONNECT ON DATABASE postgres TO :"role"', { role: ownerRole });
    try {
      const response = await postForm(baseUrl, `/_hs/trash/${ref}/purge`, { confirm: ref }, cookie);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain(
        `role ${ownerRole} still owns objects or holds privileges in the cluster; nothing was dropped`,
      );
      expect(databases()).toEqual([`${dbName}__deleted_${today()}`]);
      expect(roleLogin()).toBe("f");
    } finally {
      sharedBoxSql('REVOKE CONNECT ON DATABASE postgres FROM :"role"', { role: ownerRole });
    }
  });

  it("purges: database and role gone, row gone, ref free again", async () => {
    const refused = await postForm(baseUrl, `/_hs/trash/${ref}/purge`, { confirm: "" }, cookie);
    expect(refused.status).toBe(400);
    expect(databases()).toHaveLength(1);

    const response = await postForm(baseUrl, `/_hs/trash/${ref}/purge`, { confirm: ref }, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/_hs/trash");

    expect(databases()).toEqual([]);
    expect(roleLogin()).toBe("");
    const trash = await (await fetchWith(baseUrl, cookie, "/_hs/trash")).text();
    expect(trash).not.toContain(`data-project="${ref}"`);

    const recreated = await createProject(baseUrl, cookie, { ref, name: "Reborn", boxId });
    expect(recreated.status).toBe(302);
    expect(databases()).toEqual([dbName]);
  });
});
