import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const root = fileURLToPath(new URL("../..", import.meta.url));
const composeFiles = [
  "docker/compose.yml",
  "docker/compose.dev.yml",
  "test/compose.spike.yml",
].flatMap((file) => ["-f", file]);

function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...composeFiles, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
}

function createSpikeDatabase(database: string, table: string): void {
  const script = `
    select format('create database %I', :'db')
      where not exists (select 1 from pg_database where datname = :'db') \\gexec
    \\c :"db"
    select format('create table if not exists public.%I (id int primary key)', :'tbl') \\gexec
  `;
  compose(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `db=${database}`,
      "-v",
      `tbl=${table}`,
    ],
    script,
  );
}

async function postQuery(ref: string, query: string): Promise<Response> {
  return fetch(`${baseUrl}/api/platform/pg-meta/${ref}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

beforeAll(() => {
  createSpikeDatabase("spike_a", "alpha");
  createSpikeDatabase("spike_b", "beta");
  compose(["up", "-d", "--wait", "hattisar"]);
}, 180_000);

describe("Studio proxy with two spike projects on the shared box", () => {
  it("lists both projects in Studio's shape", async () => {
    const response = await fetch(`${baseUrl}/api/platform/projects`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ ref: "spike-a", name: "Spike A", region: "shared" }),
      expect.objectContaining({ ref: "spike-b", name: "Spike B", region: "shared" }),
    ]);
  });

  it("returns one project with an empty connection string", async () => {
    const response = await fetch(`${baseUrl}/api/platform/projects/spike-b`);
    expect(await response.json()).toMatchObject({
      ref: "spike-b",
      status: "ACTIVE_HEALTHY",
      connectionString: "",
      restUrl: "",
    });
  });

  it("runs /query against the project's database", async () => {
    const response = await postQuery("spike-b", "select current_database()");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ current_database: "spike_b" }]);
  });

  it("mirrors a pg-meta SQL error", async () => {
    const response = await postQuery("spike-b", "select * from alpha");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining("alpha"),
      formattedError: expect.any(String),
    });
  });

  it("lists the project's tables through Studio's relay route", async () => {
    const response = await fetch(`${baseUrl}/api/platform/pg-meta/spike-b/tables`, {
      headers: { "x-connection-encrypted": "client-supplied" },
    });
    expect(response.status).toBe(200);
    const names = ((await response.json()) as { name: string }[]).map((table) => table.name);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");
  });

  it("records the resolved database in the debug log", async () => {
    await postQuery("spike-a", "select 1");
    const log = (await (await fetch(`${baseUrl}/_hs/debug/pg-meta-log`)).json()) as {
      ref: string;
      db: string;
    }[];
    expect(log.at(-1)).toMatchObject({ ref: "spike-a", db: "spike_a" });
  });

  it.each([
    ["POST", "/api/platform/pg-meta/nope/query"],
    ["GET", "/api/platform/pg-meta/nope/tables"],
    ["GET", "/api/platform/projects/nope"],
  ])("answers %s %s for an unknown ref with 404", async (method, path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ query: "select 1" }) : undefined,
    });
    expect(response.status).toBe(404);
  });

  it("disables AI routes", async () => {
    const response = await fetch(`${baseUrl}/api/ai/sql/generate-v4`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "AI features are disabled in hattisar" },
    });
  });

  it("serves Studio's project page with hattisar's assets injected", async () => {
    const response = await fetch(`${baseUrl}/project/spike-b/editor`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<script src="/_hs/static/studio.js" defer></script></head>');
  });
});
