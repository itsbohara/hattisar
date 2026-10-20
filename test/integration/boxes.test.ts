import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postForm, signIn } from "../helpers/session.js";
import { compose, registrySql, stackEnv } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const PLAIN_PG = `hattisar-it-plain-pg-${randomUUID().slice(0, 8)}`;
const PLAIN_PG_PASSWORD = randomUUID();
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

function registerSharedDbAgain(name: string): Promise<Response> {
  return register({
    name,
    host: "db",
    adminUser: "supabase_admin",
    adminPassword: stackEnv().POSTGRES_PASSWORD ?? "",
  });
}

beforeAll(async () => {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PLAIN_PG,
    "--network",
    composeNetwork(),
    "-e",
    `POSTGRES_PASSWORD=${PLAIN_PG_PASSWORD}`,
    "postgres:17-alpine",
  ]);
  cookie = await signIn(baseUrl);
  await waitForTcpReady(PLAIN_PG);
}, 180_000);

afterAll(() => {
  docker(["rm", "-f", PLAIN_PG]);
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

  it("lists the missing roles of a role-less plain Postgres", async () => {
    const response = await register({
      name: "it-plain-pg",
      host: PLAIN_PG,
      adminUser: "postgres",
      adminPassword: PLAIN_PG_PASSWORD,
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    for (const role of ["supabase_admin", "anon", "authenticated", "service_role"]) {
      expect(html).toContain(`<li>Missing role: ${role}</li>`);
    }
    expect(html).not.toContain(PLAIN_PG_PASSWORD);
    expect(await boxesPage()).not.toContain('data-box="it-plain-pg"');
  });

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
