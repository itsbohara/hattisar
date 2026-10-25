import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boxesPage,
  boxIdFrom,
  docker,
  plainPgSql,
  registerBox,
  removeBox,
  startPlainPg,
  waitForTcpReady,
} from "../helpers/plain-pg.js";
import { fetchWith } from "../helpers/projects.js";
import { s3Fields, s3TestService } from "../helpers/s3.js";
import { postForm, signIn } from "../helpers/session.js";
import { registryRows, registrySql } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const suffix = randomUUID().slice(0, 8).replaceAll("-", "_");
const CONTAINER = `hattisar-it-attach-pg-${suffix}`;
const SUPERUSER_PASSWORD = randomUUID();
const boxName = `it-attach-box-${suffix}`;
const ref = `it-attach-${suffix}`;
const database = `it_attach_${suffix}`;
const login = `it_attach_${suffix}`;
const loginPassword = randomUUID();
let boxId: string;
let publicPort: string;
let cookie: string;

function adminSql(script: string): string {
  return plainPgSql(CONTAINER, script, { db: database, login, password: loginPassword });
}

// What attaching, updating the login and detaching must leave exactly as the app set it up.
// pg_authid works because the box admin of this container is a superuser. The second row is read
// inside the attached database, where a baseline or extension would show.
function snapshot(): unknown {
  const [server, inside] = adminSql(`
    select json_build_object(
      'database', (select row_to_json(d) from (
        select datname, datdba::regrole::text as owner, datacl::text
          from pg_database where datname = :'db') d),
      'role', (select row_to_json(r) from (
        select rolname, rolsuper, rolcanlogin, rolpassword, rolvaliduntil
          from pg_authid where rolname = :'login') r),
      'roles', (select json_agg(rolname order by rolname) from pg_roles)
    );
    \\connect :"db"
    select json_build_object(
      'extensions', (select json_agg(extname order by extname) from pg_extension),
      'schemas', (select json_agg(json_build_object('name', nspname, 'acl', nspacl::text)
          order by nspname)
        from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'),
      'objects', (select json_agg(json_build_object('name', c.relname, 'schema', n.nspname,
            'owner', c.relowner::regrole::text, 'acl', c.relacl::text)
          order by n.nspname, c.relname)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
    );`)
    .split("\n")
    .map((line) => JSON.parse(line));
  return { server, inside };
}

async function loginQuery(sql: string): Promise<unknown[]> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(publicPort),
    user: login,
    password: loginPassword,
    database,
    connectionTimeoutMillis: 10_000,
  });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

async function studioTables(): Promise<string[]> {
  const response = await fetchWith(baseUrl, cookie, `/api/platform/pg-meta/${ref}/tables`, {
    headers: { "x-connection-encrypted": "client-supplied" },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { name: string }[]).map((table) => table.name);
}

const attachForm = () => ({
  boxId,
  name: "Attached",
  ref,
  database,
  login,
  password: loginPassword,
});

beforeAll(async () => {
  startPlainPg(CONTAINER, "postgres:17-alpine", SUPERUSER_PASSWORD);
  publicPort = docker(["port", CONTAINER, "5432/tcp"]).split(":").at(-1) ?? "";
  cookie = await signIn(baseUrl);
  await waitForTcpReady(CONTAINER);
  adminSql(`
    create role :"login" login password :'password';
    create database :"db" owner :"login";
    \\connect :"db"
    set role :"login";
    create table public.gadgets (id int primary key);
    insert into public.gadgets values (1), (2);`);
  const registered = await registerBox(baseUrl, cookie, {
    name: boxName,
    host: CONTAINER,
    adminUser: "postgres",
    adminPassword: SUPERUSER_PASSWORD,
    publicHost: "127.0.0.1",
    publicPort,
  });
  expect(registered.status, await registered.clone().text()).toBe(302);
  boxId = boxIdFrom(await boxesPage(baseUrl, cookie), boxName);
}, 180_000);

afterAll(async () => {
  try {
    registrySql("DELETE FROM projects WHERE ref = ?", ref);
    registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
    const html = await boxesPage(baseUrl, cookie);
    if (html.includes(`data-box="${boxName}"`))
      await removeBox(baseUrl, cookie, boxIdFrom(html, boxName));
  } finally {
    registrySql("DELETE FROM boxes WHERE name = ?", boxName);
    docker(["rm", "-f", CONTAINER]);
  }
});

describe("attached projects", () => {
  it("attaches a database, serves it through Studio and detaches it without touching it", async () => {
    const before = snapshot();

    const attached = await postForm(baseUrl, "/_hs/projects/attach", attachForm(), cookie);
    expect(attached.status, await attached.clone().text()).toBe(302);
    expect(attached.headers.get("location")).toBe(`/_hs/projects/${ref}`);
    expect(await studioTables()).toContain("gadgets");

    const rotated = await postForm(baseUrl, `/_hs/projects/${ref}/rotate`, {}, cookie);
    expect(rotated.status).not.toBe(302);
    expect(snapshot()).toEqual(before);

    const saved = await postForm(baseUrl, "/_hs/settings/s3", s3Fields(s3TestService()), cookie);
    expect(saved.status).toBe(200);
    const backedUp = await postForm(baseUrl, `/_hs/projects/${ref}/backups`, {}, cookie);
    expect(backedUp.status).toBe(302);
    const [backup] = registryRows<{ status: string }>(
      `SELECT b.status FROM backups b JOIN projects p ON p.id = b.project_id
        WHERE p.ref = ? ORDER BY b.id DESC LIMIT 1`,
      ref,
    );
    expect(backup?.status).toBe("done");

    const updated = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/login`,
      { login, password: loginPassword },
      cookie,
    );
    expect(updated.status, await updated.clone().text()).toBe(302);
    expect(await studioTables()).toContain("gadgets");
    expect(snapshot()).toEqual(before);

    const detached = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/detach`,
      { confirm: ref },
      cookie,
    );
    expect(detached.status).toBe(302);
    expect((await fetchWith(baseUrl, cookie, `/_hs/projects/${ref}`)).status).toBe(404);

    expect(snapshot()).toEqual(before);
    expect(await loginQuery("select id from public.gadgets order by id")).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  }, 120_000);
});
