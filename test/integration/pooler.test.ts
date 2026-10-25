import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { poolerRoleFor } from "../../src/pooler/role.js";
import { deriveSecretKey } from "../../src/registry/secrets.js";
import { createProject, dropProject, fetchWith } from "../helpers/projects.js";
import { postForm, signIn } from "../helpers/session.js";
import { registrySql, sharedBoxSql, stackEnv } from "../stack.js";

const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const suffix = randomUUID().slice(0, 8);
const boxName = `it-pool-${suffix}`;
const ref = `it-pl-${suffix}`;
const dbName = ref.replaceAll("-", "_");
const ownerRole = `hs_${dbName}_owner`;
const tokenName = `it-pool-${suffix}`;
const probeRole = `it_pool_probe_${suffix}`;
let cookie: string;
let token: string;
let tokenId: string | undefined;
let boxId: string | undefined;
let tenant: string;
let ports: { session: string; transaction: string };

type Kind = "session" | "transaction" | "direct";

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

async function connectError(url: string): Promise<string> {
  try {
    await withClient(url, async () => undefined);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("connected, but expected the connection to be refused");
}

async function boxesPage(): Promise<string> {
  const response = await fetchWith(baseUrl, cookie, "/_hs/boxes");
  expect(response.status).toBe(200);
  return response.text();
}

function boxRowHtml(html: string, name: string): string | undefined {
  return html.split("<tr").find((part) => part.includes(`data-box="${name}"`));
}

async function connections(): Promise<{ kind: Kind; url: string }[]> {
  const response = await fetch(`${baseUrl}/_hs/api/v1/projects/${ref}/connections`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { kind: Kind; url: string }[];
}

async function connection(kind: Kind): Promise<string> {
  const found = (await connections()).find((entry) => entry.kind === kind);
  if (!found) throw new Error(`${ref} has no ${kind} connection`);
  return found.url;
}

async function removeBox(): Promise<number | undefined> {
  if (boxId === undefined) return undefined;
  const response = await postForm(baseUrl, `/_hs/boxes/${boxId}/remove`, {}, cookie);
  if (response.status === 302) boxId = undefined;
  return response.status;
}

beforeAll(async () => {
  cookie = await signIn(baseUrl);
  const env = stackEnv();
  tenant = `${env.POOLER_TENANT_ID}-${boxName}`;
  ports = {
    session: env.POOLER_PORT_SESSION || "54322",
    transaction: env.POOLER_PORT_TRANSACTION || "6543",
  };
  const response = await postForm(
    baseUrl,
    "/_hs/settings/tokens",
    { name: tokenName, expiry: "30" },
    cookie,
  );
  const html = await response.text();
  if (response.status !== 201) throw new Error(`creating a token failed with ${response.status}`);
  tokenId = new RegExp(`<tr data-token="(\\d+)"><td>${tokenName}</td>`).exec(html)?.[1];
  const created = /<input readonly="" value="(hs_[^"]+)"/.exec(html)?.[1];
  if (!created || !tokenId) throw new Error("the token page did not show the new token");
  token = created;
}, 60_000);

// Through hattisar where possible, so a box left behind by a failed test takes its tenant with it.
afterAll(async () => {
  try {
    if (tokenId !== undefined) {
      await postForm(baseUrl, `/_hs/settings/tokens/${tokenId}/revoke`, {}, cookie);
    }
    dropProject(ref);
    await removeBox();
    sharedBoxSql('DROP ROLE IF EXISTS :"role"', { role: probeRole });
  } finally {
    registrySql("DELETE FROM boxes WHERE name = ?", boxName);
  }
});

describe("a project on a registered box with a pooler tenant", () => {
  it("registers the stack's db as a box and gives it a tenant", async () => {
    const response = await postForm(
      baseUrl,
      "/_hs/boxes",
      {
        name: boxName,
        host: "db",
        port: "5432",
        adminUser: "supabase_admin",
        adminPassword: stackEnv().POSTGRES_PASSWORD ?? "",
        sslmode: "disable",
        publicHost: "localhost",
        publicPort: "5432",
      },
      cookie,
    );
    expect(response.status, await response.clone().text()).toBe(302);
    const row = boxRowHtml(await boxesPage(), boxName);
    boxId = row?.match(/\/_hs\/boxes\/(\d+)\/edit/)?.[1];
    expect(boxId).toBeDefined();
    expect(row).toContain(`<code>${tenant}</code>`);
  }, 60_000);

  it("offers session, transaction and direct strings", async () => {
    const response = await createProject(baseUrl, cookie, {
      ref,
      name: "Pooled",
      boxId: boxId as string,
    });
    expect(response.status, await response.clone().text()).toBe(302);
    const entries = await connections();
    expect(entries.map((entry) => entry.kind)).toEqual(["session", "transaction", "direct"]);
    const [session, transaction] = entries.map((entry) => new URL(entry.url));
    expect(session?.username).toBe(`${ownerRole}.${tenant}`);
    expect(session?.port).toBe(ports.session);
    expect(transaction?.username).toBe(`${ownerRole}.${tenant}`);
    expect(transaction?.port).toBe(ports.transaction);
  }, 60_000);

  it.each(["session", "transaction"] as const)(
    "lets the owner connect from the host through the %s port",
    async (kind) => {
      const rows = await withClient(
        await connection(kind),
        async (client) => (await client.query("select current_user, current_database()")).rows,
      );
      expect(rows).toEqual([{ current_user: ownerRole, current_database: dbName }]);
    },
  );

  it("accepts the new password through the pooler after a rotate", async () => {
    const before = await connection("session");
    const response = await postForm(baseUrl, `/_hs/projects/${ref}/rotate`, {}, cookie);
    expect(response.status).toBe(302);
    const after = await connection("session");
    expect(after).not.toBe(before);
    for (const kind of ["session", "transaction"] as const) {
      const rows = await withClient(
        await connection(kind),
        async (client) => (await client.query("select current_database()")).rows,
      );
      expect(rows).toEqual([{ current_database: dbName }]);
    }
  });

  // A role Supavisor has never seen, so its login needs the auth query as the tenant's role rather
  // than secrets Supavisor cached for the owner.
  it("re-syncs a tenant whose role password drifted, as after a box restore", async () => {
    const tenantRole = poolerRoleFor(deriveSecretKey(stackEnv().HATTISAR_SECRET_KEY ?? ""), tenant);
    const probePassword = randomBytes(16).toString("hex");
    sharedBoxSql(
      `CREATE ROLE :"probe" LOGIN PASSWORD :'probePassword';
       ALTER ROLE :"role" PASSWORD :'rolePassword';
       SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = :'role';`,
      {
        probe: probeRole,
        probePassword,
        role: tenantRole,
        rolePassword: randomBytes(16).toString("hex"),
      },
    );
    const probe = new URL(await connection("session"));
    probe.username = `${probeRole}.${tenant}`;
    probe.password = probePassword;
    probe.pathname = "/postgres";
    expect(await connectError(probe.href)).not.toBe("");

    const response = await fetch(`${baseUrl}/_hs/api/v1/boxes/${boxId}/pooler/resync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ tenant });

    // Supavisor reconnects its auth query to the box after the re-sync; until then a login fails
    // with "connection to database not available".
    for (const url of [probe.href, await connection("session")]) {
      const rows = await vi.waitFor(
        () => withClient(url, async (client) => (await client.query("select current_user")).rows),
        { timeout: 20_000, interval: 1_000 },
      );
      expect(rows).toHaveLength(1);
    }
  }, 60_000);

  it("drops the tenant with the box, so the pooler no longer knows the owner", async () => {
    const session = await connection("session");
    const deleted = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/delete`,
      { confirm: ref },
      cookie,
    );
    expect(deleted.status).toBe(302);
    const purged = await postForm(baseUrl, `/_hs/trash/${ref}/purge`, { confirm: ref }, cookie);
    expect(purged.status).toBe(302);
    expect(await removeBox()).toBe(302);
    expect(boxRowHtml(await boxesPage(), boxName)).toBeUndefined();
    expect(await connectError(session)).not.toBe("");
  }, 60_000);
});
