import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SupavisorApi,
  SupavisorError,
  signApiJwt,
  type TenantBody,
} from "../../src/pooler/supavisor.js";

const SECRET = "jwt-secret-value-123";
const NOW = 1_700_000_000;
const TOKEN = signApiJwt(SECRET, NOW);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = { status: number; body?: unknown; raw?: string } | Error;

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body as string | undefined,
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    if (reply instanceof Error) throw reply;
    const text = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function api(replies: Reply[]) {
  const fake = fakeFetch(replies);
  return {
    ...fake,
    client: new SupavisorApi({ jwtSecret: SECRET, fetch: fake.fetch, now: () => NOW }),
  };
}

const body: TenantBody = {
  db_host: "box-db",
  db_port: 5432,
  db_database: "postgres",
  require_user: false,
  auth_query: "SELECT * FROM hattisar_pooler.get_auth($1)",
  upstream_ssl: false,
  ip_version: "auto",
  default_pool_size: 20,
  default_max_clients: 100,
  users: [
    {
      db_user: "hattisar_pooler",
      db_password: "pw123",
      mode_type: "transaction",
      pool_size: 20,
      is_manager: true,
    },
  ],
};

async function caught(promise: Promise<unknown>): Promise<SupavisorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SupavisorError);
    return error as SupavisorError;
  }
  throw new Error("expected a rejection");
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("signApiJwt", () => {
  it("signs an HS256 token that expires in 60 seconds", () => {
    const parts = signApiJwt("s", 1000).split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    const [h, p, sig] = parts as [string, string, string];
    expect(decode(h)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decode(p)).toEqual({ exp: 1060 });
    expect(sig).toBe(createHmac("sha256", "s").update(`${h}.${p}`).digest("base64url"));
  });
});

describe("SupavisorApi.put", () => {
  it("PUTs the tenant wrapped in {tenant} with a bearer token", async () => {
    const { client, calls } = api([{ status: 201, body: { data: {} } }]);
    await client.put("hattisar-b1", body);
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.url).toBe("http://supavisor:4000/api/tenants/hattisar-b1");
    expect(call.method).toBe("PUT");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.body ?? "")).toEqual({ tenant: body });
  });

  it("accepts 200 for an updated tenant", async () => {
    const { client } = api([{ status: 200, body: { data: {} } }]);
    await expect(client.put("hattisar-b1", body)).resolves.toBeUndefined();
  });

  it.each(["hattisar.b1", "hattisar/b1"])("rejects id %s before any fetch", async (id) => {
    const { client, calls } = api([]);
    await expect(client.put(id, body)).rejects.toThrow(/Invalid Supavisor tenant id/);
    expect(calls).toHaveLength(0);
  });

  it("keeps Supavisor's error but scrubs the password and never shows the token", async () => {
    const { client } = api([
      {
        status: 400,
        body: { error: "Can't connect the user hattisar_pooler: password pw123 rejected" },
      },
    ]);
    const error = await caught(client.put("hattisar-b1", body, "pw123"));
    expect(error.status).toBe(400);
    expect(error.message).toContain("Can't connect");
    expect(error.message).not.toContain("pw123");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(SECRET);
  });
});

describe("SupavisorApi.get", () => {
  it("maps the tenant's host and port", async () => {
    const { client, calls } = api([
      { status: 200, body: { data: { db_host: "h", db_port: 5432, external_id: "hattisar-b1" } } },
    ]);
    await expect(client.get("hattisar-b1")).resolves.toEqual({ dbHost: "h", dbPort: 5432 });
    expect(calls[0]?.url).toBe("http://supavisor:4000/api/tenants/hattisar-b1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each<[string, Reply]>([
    ["a non-JSON body", { status: 200, raw: "<html>secret-ish page</html>" }],
    ["a body without data", { status: 200, body: { other: "secret-ish" } }],
    ["a null data", { status: 200, body: { data: null } }],
    ["data without fields", { status: 200, body: { data: {} } }],
    ["a non-string host", { status: 200, body: { data: { db_host: 42, db_port: 5432 } } }],
    ["a string port", { status: 200, body: { data: { db_host: "secret-ish", db_port: "5432" } } }],
  ])("rejects %s without quoting it", async (_, reply) => {
    const { client } = api([reply]);
    const error = await caught(client.get("hattisar-b1"));
    expect(error.status).toBe(200);
    expect(error.message).toBe(
      "Supavisor GET /api/tenants/hattisar-b1 failed: unexpected response",
    );
  });

  it("maps 404 to undefined", async () => {
    const { client } = api([{ status: 404, body: { error: "not found" } }]);
    await expect(client.get("hattisar-b1")).resolves.toBeUndefined();
  });
});

describe("SupavisorApi.remove", () => {
  it("terminates the pools, then deletes the tenant", async () => {
    const { client, calls } = api([{ status: 204 }, { status: 204 }]);
    await client.remove("hattisar-b1");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "http://supavisor:4000/api/tenants/hattisar-b1/terminate"],
      ["DELETE", "http://supavisor:4000/api/tenants/hattisar-b1"],
    ]);
  });

  it("counts 404 on either call as done", async () => {
    const { client, calls } = api([
      { status: 404, body: { error: "not found" } },
      { status: 404, body: { error: "not found" } },
    ]);
    await expect(client.remove("hattisar-b1")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

describe("SupavisorApi failures", () => {
  it("reports a 403 with a fixed message", async () => {
    const { client } = api([{ status: 403, body: { error: `bad token ${SECRET}` } }]);
    const error = await caught(client.get("hattisar-b1"));
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Supavisor GET /api/tenants/hattisar-b1 failed: Supavisor rejected the API token",
    );
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(TOKEN);
  });

  it("reports a network failure as status 0", async () => {
    const { client } = api([new TypeError(`fetch failed ${SECRET} ${TOKEN}`)]);
    const error = await caught(client.get("hattisar-b1"));
    expect(error.status).toBe(0);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(TOKEN);
  });

  it("reports a timeout as status 0", async () => {
    const { client } = api([
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]);
    const error = await caught(client.get("hattisar-b1"));
    expect(error.status).toBe(0);
    expect(error.message).toContain("timed out");
  });

  it("never echoes a raw body without an error field", async () => {
    const { client } = api([{ status: 500, body: { detail: "internal", token: TOKEN } }]);
    const error = await caught(client.get("hattisar-b1"));
    expect(error.status).toBe(500);
    expect(error.message).not.toContain("internal");
    expect(error.message).not.toContain(TOKEN);
  });
});
