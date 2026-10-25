import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionStrings, createProject, fetchWith } from "../helpers/projects.js";
import { s3Fields, s3TestService } from "../helpers/s3.js";
import { postForm, signIn } from "../helpers/session.js";
import { compose, registryRows, registrySql, stackEnv } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const PLAIN_PG = `hattisar-it-plain-pg-${randomUUID().slice(0, 8)}`;
const PLAIN_PG_18 = `hattisar-it-plain-pg18-${randomUUID().slice(0, 8)}`;
const PLAIN_PG_15 = `hattisar-it-plain-pg15-${randomUUID().slice(0, 8)}`;
const PLAIN_PG_PASSWORD = randomUUID();
const plainBox = `it-plain-${randomUUID().slice(0, 8)}`;
const plainRef = `it-plain-${randomUUID().slice(0, 8)}`;
const pg18Box = `it-plain-pg18-${randomUUID().slice(0, 8)}`;
const pg18Ref = `it-pg18-${randomUUID().slice(0, 8)}`;
const pg15Box = `it-plain-pg15-${randomUUID().slice(0, 8)}`;
const pg15Ref = `it-pg15-${randomUUID().slice(0, 8)}`;
let plainPgPort: string;
let pg18Port: string;
let pg15Port: string;
let cookie: string;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function composeNetwork(): string {
  const db = compose(["ps", "-q", "db"]).trim();
  return docker([
    "inspect",
    "-f",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}",
    db,
  ]);
}

// The init-time server listens on the unix socket only, so TCP readiness means the real server.
async function waitForTcpReady(container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`${container} never became ready`);
}

async function boxesPage(): Promise<string> {
  const response = await fetch(`${baseUrl}/_hs/boxes`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.text();
}

function boxIdFrom(html: string, name: string): string {
  const row = html.split("<tr").find((part) => part.includes(`data-box="${name}"`));
  const id = row?.match(/\/_hs\/boxes\/(\d+)\/edit/)?.[1];
  if (!id) throw new Error(`box ${name} not listed`);
  return id;
}

function register(fields: Record<string, string>): Promise<Response> {
  return postForm(
    baseUrl,
    "/_hs/boxes",
    { port: "5432", sslmode: "disable", publicHost: "localhost", publicPort: "5432", ...fields },
    cookie,
  );
}

function remove(id: string): Promise<Response> {
  return postForm(baseUrl, `/_hs/boxes/${id}/remove`, {}, cookie);
}

function registerPlainPg(name: string, host: string, publicPort = "5432"): Promise<Response> {
  return register({
    name,
    host,
    adminUser: "postgres",
    adminPassword: PLAIN_PG_PASSWORD,
    publicHost: "127.0.0.1",
    publicPort,
  });
}

function startPlainPg(name: string, image: string): void {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    composeNetwork(),
    "-p",
    "127.0.0.1::5432",
    "-e",
    `POSTGRES_PASSWORD=${PLAIN_PG_PASSWORD}`,
    image,
  ]);
}

async function ownerQuery(url: string, sql: string): Promise<unknown[]> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

function ownerSelectOne(url: string): Promise<unknown[]> {
  return ownerQuery(url, "select current_user, 1 as ok");
}

async function directString(ref: string, port: string): Promise<string> {
  const direct = (await connectionStrings(baseUrl, cookie, ref)).find(
    (url) => new URL(url).port === port,
  );
  if (!direct) throw new Error(`${ref} has no direct connection string`);
  return direct;
}

function deleteProject(ref: string): Promise<Response> {
  return postForm(baseUrl, `/_hs/projects/${ref}/delete`, { confirm: ref }, cookie);
}

function purgeProject(ref: string): Promise<Response> {
  return postForm(baseUrl, `/_hs/trash/${ref}/purge`, { confirm: ref }, cookie);
}

function registerSharedDbAgain(name: string): Promise<Response> {
  return register({
    name,
    host: "db",
    adminUser: "supabase_admin",
    adminPassword: stackEnv().POSTGRES_PASSWORD ?? "",
  });
}

beforeAll(async () => {
  startPlainPg(PLAIN_PG, "postgres:17-alpine");
  startPlainPg(PLAIN_PG_18, "postgres:18-alpine");
  startPlainPg(PLAIN_PG_15, "postgres:15-alpine");
  plainPgPort = docker(["port", PLAIN_PG, "5432/tcp"]).split(":").at(-1) ?? "";
  pg18Port = docker(["port", PLAIN_PG_18, "5432/tcp"]).split(":").at(-1) ?? "";
  pg15Port = docker(["port", PLAIN_PG_15, "5432/tcp"]).split(":").at(-1) ?? "";
  cookie = await signIn(baseUrl);
  await waitForTcpReady(PLAIN_PG);
  await waitForTcpReady(PLAIN_PG_18);
  await waitForTcpReady(PLAIN_PG_15);
}, 180_000);

// Only hattisar's rows and the box's pooler tenant can outlive a failed test. Removing the box
// drops the tenant.
afterAll(async () => {
  try {
    registrySql("DELETE FROM projects WHERE ref = ?", plainRef);
    registrySql("DELETE FROM projects WHERE ref = ?", pg18Ref);
    registrySql("DELETE FROM projects WHERE ref = ?", pg15Ref);
    registrySql("DELETE FROM settings WHERE key LIKE 's3.%'");
    const html = await boxesPage();
    for (const name of [plainBox, pg18Box, pg15Box]) {
      if (html.includes(`data-box="${name}"`)) await remove(boxIdFrom(html, name));
    }
  } finally {
    registrySql("DELETE FROM boxes WHERE name = ?", plainBox);
    registrySql("DELETE FROM boxes WHERE name = ?", pg18Box);
    registrySql("DELETE FROM boxes WHERE name = ?", pg15Box);
    docker(["rm", "-f", PLAIN_PG, PLAIN_PG_18, PLAIN_PG_15]);
  }
});

describe("boxes", () => {
  it("seeds the shared box exactly once across restarts", async () => {
    const count = (html: string) => html.split('data-box="shared"').length - 1;
    expect(count(await boxesPage())).toBe(1);
    compose(["restart", "hattisar"]);
    compose(["up", "-d", "--wait", "hattisar"]);
    cookie = await signIn(baseUrl);
    const html = await boxesPage();
    expect(count(html)).toBe(1);
    expect(html).toContain("<code>db:5432</code>");
  }, 120_000);

  it("registers the shared db under another name when E1 passes, then removes it", async () => {
    const name = `it-db-${randomUUID().slice(0, 8)}`;
    const response = await registerSharedDbAgain(name);
    expect(response.status).toBe(302);
    const id = boxIdFrom(await boxesPage(), name);
    expect((await remove(id)).status).toBe(302);
    expect(await boxesPage()).not.toContain(`data-box="${name}"`);
  });

  it("registers a plain Postgres 17 and runs a project on it end to end", async () => {
    expect((await registerPlainPg(plainBox, PLAIN_PG, plainPgPort)).status).toBe(302);
    const boxId = boxIdFrom(await boxesPage(), plainBox);
    const created = await createProject(baseUrl, cookie, {
      ref: plainRef,
      name: "Plain",
      boxId,
    });
    expect(created.status, await created.clone().text()).toBe(302);

    expect(await connectionStrings(baseUrl, cookie, plainRef)).toHaveLength(3);
    const direct = await directString(plainRef, plainPgPort);
    const owner = [{ current_user: `hs_${plainRef.replaceAll("-", "_")}_owner`, ok: 1 }];
    expect(await ownerSelectOne(direct)).toEqual(owner);

    expect((await deleteProject(plainRef)).status).toBe(302);
    const restored = await postForm(baseUrl, `/_hs/trash/${plainRef}/restore`, {}, cookie);
    expect(restored.status).toBe(302);
    expect(await ownerSelectOne(direct)).toEqual(owner);

    expect((await deleteProject(plainRef)).status).toBe(302);
    expect((await purgeProject(plainRef)).status).toBe(302);
    expect((await remove(boxId)).status).toBe(302);
    expect(await boxesPage()).not.toContain(`data-box="${plainBox}"`);
  }, 60_000);

  it("registers a plain Postgres 18 and dumps a project on it", async () => {
    expect((await registerPlainPg(pg18Box, PLAIN_PG_18, pg18Port)).status).toBe(302);
    const boxId = boxIdFrom(await boxesPage(), pg18Box);
    const created = await createProject(baseUrl, cookie, { ref: pg18Ref, name: "PG18", boxId });
    expect(created.status, await created.clone().text()).toBe(302);

    const dump = await fetchWith(baseUrl, cookie, `/_hs/projects/${pg18Ref}/dump`);
    expect(dump.status).toBe(200);
    const archive = Buffer.from(await dump.arrayBuffer());
    expect(archive.subarray(0, 5).toString()).toBe("PGDMP");

    // The dump holds the project until pg_dump exits, which can be after the body is read.
    await expect
      .poll(async () => (await deleteProject(pg18Ref)).status, { timeout: 10_000 })
      .toBe(302);
    expect((await purgeProject(pg18Ref)).status).toBe(302);
    expect((await remove(boxId)).status).toBe(302);
    expect(await boxesPage()).not.toContain(`data-box="${pg18Box}"`);
  }, 60_000);

  it("restores a backup into a plain Postgres 15 despite pg_restore's newer SET", async () => {
    expect((await registerPlainPg(pg15Box, PLAIN_PG_15, pg15Port)).status).toBe(302);
    const boxId = boxIdFrom(await boxesPage(), pg15Box);
    const created = await createProject(baseUrl, cookie, { ref: pg15Ref, name: "PG15", boxId });
    expect(created.status, await created.clone().text()).toBe(302);
    const direct = await directString(pg15Ref, pg15Port);
    await ownerQuery(
      direct,
      "create table public.widgets (id int primary key); insert into public.widgets values (1)",
    );

    const saved = await postForm(baseUrl, "/_hs/settings/s3", s3Fields(s3TestService()), cookie);
    expect(saved.status).toBe(200);
    const backedUp = await postForm(baseUrl, `/_hs/projects/${pg15Ref}/backups`, {}, cookie);
    expect(backedUp.status).toBe(302);
    const [backup] = registryRows<{ id: number; status: string }>(
      `SELECT b.id, b.status FROM backups b JOIN projects p ON p.id = b.project_id
        WHERE p.ref = ? ORDER BY b.id DESC LIMIT 1`,
      pg15Ref,
    );
    expect(backup?.status).toBe("done");
    await ownerQuery(direct, "insert into public.widgets values (2)");

    const restored = await postForm(
      baseUrl,
      `/_hs/projects/${pg15Ref}/backups/${backup?.id}/restore`,
      { confirm: pg15Ref },
      cookie,
    );
    expect(restored.status, await restored.clone().text()).toBe(302);
    expect(restored.headers.get("location")).toBe(`/_hs/projects/${pg15Ref}/backups?restored`);
    expect(await ownerQuery(direct, "select id from public.widgets order by id")).toEqual([
      { id: 1 },
    ]);

    expect((await deleteProject(pg15Ref)).status).toBe(302);
    expect((await purgeProject(pg15Ref)).status).toBe(302);
    expect((await remove(boxId)).status).toBe(302);
    expect(await boxesPage()).not.toContain(`data-box="${pg15Box}"`);
  }, 120_000);

  it("explains a connection failure as one problem", async () => {
    const response = await register({
      name: "it-wrong-password",
      host: PLAIN_PG,
      adminUser: "postgres",
      adminPassword: "definitely-wrong",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(
      /<li>cannot connect: [^<]*password authentication failed/,
    );
  });

  it("refuses to remove a box that has projects", async () => {
    const name = `it-busy-${randomUUID().slice(0, 8)}`;
    expect((await registerSharedDbAgain(name)).status).toBe(302);
    const id = boxIdFrom(await boxesPage(), name);
    const ref = `it-${randomUUID().slice(0, 8)}`;
    registrySql(
      `INSERT INTO projects (ref, name, box_id, db_name, owner_role, owner_password_enc, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'v1:x:y:z', 'active', '2026-10-20T00:00:00.000Z')`,
      ref,
      ref,
      Number(id),
      "it_unused",
      "it_unused_owner",
    );
    try {
      const refused = await remove(id);
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain(`Box ${name} still has 1 project`);
    } finally {
      registrySql("DELETE FROM projects WHERE ref = ?", ref);
    }
    expect((await remove(id)).status).toBe(302);
  });
});
