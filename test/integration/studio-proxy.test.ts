import { beforeAll, describe, expect, it } from "vitest";
import { prepareRoutingProjects } from "../helpers/projects.js";
import { signIn } from "../helpers/session.js";
import { compose, stackEnv } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
let cookie: string;

function fetchSignedIn(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (!headers.has("origin")) headers.set("origin", baseUrl);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function postQuery(ref: string, query: string): Promise<Response> {
  return fetchSignedIn(`/api/platform/pg-meta/${ref}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

beforeAll(async () => {
  await prepareRoutingProjects(baseUrl);
  cookie = await signIn(baseUrl);
}, 180_000);

describe("Studio proxy with two projects on the shared box", () => {
  it("lists both projects in Studio's shape", async () => {
    const response = await fetchSignedIn("/api/platform/projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ ref: "spike-a", name: "Spike A", region: "shared" }),
      expect.objectContaining({ ref: "spike-b", name: "Spike B", region: "shared" }),
    ]);
  });

  it("returns one project with an empty connection string", async () => {
    const response = await fetchSignedIn("/api/platform/projects/spike-b");
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
    const response = await fetchSignedIn("/api/platform/pg-meta/spike-b/tables", {
      headers: { "x-connection-encrypted": "client-supplied" },
    });
    expect(response.status).toBe(200);
    const names = ((await response.json()) as { name: string }[]).map((table) => table.name);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");
  });

  it("records the resolved database in the debug log", async () => {
    await postQuery("spike-a", "select 1");
    const log = (await (await fetchSignedIn("/_hs/debug/pg-meta-log")).json()) as {
      ref: string;
      db: string;
    }[];
    expect(log.at(-1)).toMatchObject({ ref: "spike-a", db: "spike_a" });
  });

  it.each([
    ["POST", "/api/platform/pg-meta/nope/query"],
    ["GET", "/api/platform/pg-meta/nope/tables"],
    ["GET", "/api/platform/projects/nope"],
    ["GET", "/api/platform/projects/nope/databases"],
    ["GET", "/api/v1/projects/nope/types/typescript"],
    ["GET", "/api/v1/projects/nope/api-keys"],
  ])("answers %s %s for an unknown ref with 404", async (method, path) => {
    const response = await fetchSignedIn(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ query: "select 1" }) : undefined,
    });
    expect(response.status).toBe(404);
  });

  it("describes the project's database", async () => {
    const response = await fetchSignedIn("/api/platform/projects/spike-b/databases");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        identifier: "spike-b",
        db_name: "spike_b",
        db_host: stackEnv().HATTISAR_PUBLIC_HOST || "localhost",
        db_port: Number(stackEnv().POOLER_PORT_SESSION || 54322),
        db_user: "hs_spike_b_owner",
        status: "ACTIVE_HEALTHY",
      }),
    ]);
  });

  it("generates TypeScript types from the project's database", async () => {
    const response = await fetchSignedIn("/api/v1/projects/spike-b/types/typescript");
    expect(response.status).toBe(200);
    const { types } = (await response.json()) as { types: string };
    expect(types).toContain("beta:");
    expect(types).not.toContain("alpha:");
  });

  it("answers run-lints with no lints, so Studio does not retry it", async () => {
    const response = await fetchSignedIn("/api/platform/projects/spike-b/run-lints");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect((await fetchSignedIn("/api/platform/projects/nope/run-lints")).status).toBe(404);
  });

  it.each(["//meta:8080/health", "//docker-proxy:2375/containers/json", "/%2F%2Fmeta:8080/health"])(
    "never fetches the host named in %s",
    async (path) => {
      const response = await fetchSignedIn(path);
      expect(response.status).toBe(404);
    },
  );

  it("refuses a cross-origin POST that would run SQL", async () => {
    const response = await fetchSignedIn("/api/platform/pg-meta/spike-b/query", {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ query: "select 1" }),
    });
    expect(response.status).toBe(403);
  });

  it.each([
    ["POST", "/api/platform/projects/spike-b/run-lints"],
    ["GET", "/api/v1/projects/spike-b/database/migrations"],
    ["POST", "/api/mcp"],
  ])("refuses %s %s, which only reach Studio's own connection", async (method, path) => {
    const response = await fetchSignedIn(path, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: "Not available in hattisar" } });
  });

  it("fails closed when Studio or meta are reached without a project connection", () => {
    const probe = `
      const json = { "content-type": "application/json" };
      const calls = [
        ["http://meta:8080/tables", {}],
        ["http://studio:3000/api/platform/pg-meta/default/query",
          { method: "POST", headers: json, body: JSON.stringify({ query: "select 1" }) }],
      ];
      Promise.all(calls.map(async ([url, init]) => {
        const response = await fetch(url, init);
        return { status: response.status, body: await response.text() };
      })).then((results) => console.log(JSON.stringify(results)));
    `;
    const results = JSON.parse(compose(["exec", "-T", "hattisar", "node", "-e", probe])) as {
      status: number;
      body: string;
    }[];
    expect(results).toHaveLength(2);
    for (const { status, body } of results) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body).toContain('database \\"hattisar_no_project\\" does not exist');
    }
  });

  it("disables AI routes", async () => {
    const response = await fetchSignedIn("/api/ai/sql/generate-v4", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "AI features are disabled in hattisar" },
    });
  });

  it("serves Studio's project page with hattisar's assets injected", async () => {
    const response = await fetchSignedIn("/project/spike-b/editor");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<script src="/_hs/static/studio.js" defer></script></head>');
  });
});
