import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionStrings, createProject, fetchWith } from "../helpers/projects.js";
import { postForm, signIn } from "../helpers/session.js";
import { registryRows, registrySql, stackEnv } from "../stack.js";

// Needs the stack with the managed-boxes profile and HATTISAR_MANAGED_BOXES=true (pnpm stack:up).
const baseUrl = process.env.HATTISAR_URL ?? "http://localhost:8000";
const suffix = randomUUID().slice(0, 8);
const ref = `it-mb-${suffix}`;
const dbName = ref.replaceAll("-", "_");
const spareBox = `it-mbx-${suffix}`;
const unlabelledBox = `it-mbu-${suffix}`;
const unlabelledContainer = `hattisar-box-${unlabelledBox}`;
const BOOT_TIMEOUT = 240_000;
let cookie: string;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function dockerQuiet(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

interface ContainerState {
  running: boolean;
  labels: Record<string, string>;
}

function container(name: string): ContainerState | undefined {
  try {
    const [state] = JSON.parse(dockerQuiet(["inspect", name])) as {
      State: { Running: boolean };
      Config: { Labels: Record<string, string> | null };
    }[];
    return state && { running: state.State.Running, labels: state.Config.Labels ?? {} };
  } catch {
    return undefined;
  }
}

function volumeExists(name: string): boolean {
  return docker(["volume", "ls", "-q", "--filter", `name=^${name}$`]) !== "";
}

// Every container and volume a test made for one of its boxes, found by label.
function removeByLabel(box: string): void {
  const filter = `label=hattisar.box=${box}`;
  const containers = docker([
    "ps",
    "-aq",
    "--filter",
    "label=hattisar.managed=true",
    "--filter",
    filter,
  ]);
  if (containers) docker(["rm", "-f", ...containers.split("\n")]);
  const volumes = docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    "label=hattisar.managed=true",
    "--filter",
    filter,
  ]);
  if (volumes) docker(["volume", "rm", ...volumes.split("\n")]);
}

function boxRow(name: string) {
  return registryRows<{ id: number; kind: string; host: string; port: number; publicPort: number }>(
    "SELECT id, kind, host, port, public_port AS publicPort FROM boxes WHERE name = ?",
    name,
  )[0];
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

beforeAll(async () => {
  cookie = await signIn(baseUrl);
  const form = await fetchWith(baseUrl, cookie, "/_hs/managed-boxes/new");
  if (form.status !== 200) {
    throw new Error("managed boxes are off: run the stack with pnpm stack:up");
  }
});

afterAll(() => {
  registrySql("DELETE FROM projects WHERE ref = ?", ref);
  for (const name of [ref, spareBox, unlabelledBox]) {
    registrySql("DELETE FROM boxes WHERE name = ?", name);
    removeByLabel(name);
  }
  dockerQuiet(["rm", "-f", unlabelledContainer]);
});

describe("a project on a new dedicated box", () => {
  let url: string;

  it(
    "starts a labelled container, passes E1 and registers it as managed",
    async () => {
      const response = await createProject(baseUrl, cookie, {
        ref,
        name: "Managed",
        boxId: "new",
      });
      expect(response.status, await response.clone().text()).toBe(302);
      expect(response.headers.get("location")).toBe(`/_hs/projects/${ref}`);

      expect(container(`hattisar-box-${ref}`)).toEqual({
        running: true,
        labels: expect.objectContaining({ "hattisar.managed": "true", "hattisar.box": ref }),
      });
      expect(volumeExists(`hattisar_box_${ref}`)).toBe(true);
      const box = boxRow(ref);
      expect(box).toMatchObject({ kind: "managed", host: `hattisar-box-${ref}`, port: 5432 });
      expect(box?.publicPort).toBeGreaterThanOrEqual(55000);
      expect(box?.publicPort).toBeLessThanOrEqual(55999);
    },
    BOOT_TIMEOUT,
  );

  it("gives the project a direct connection string that works from the host", async () => {
    const strings = await connectionStrings(baseUrl, cookie, ref);
    expect(strings).toHaveLength(3);
    url = strings[2] as string;
    const parsed = new URL(url);
    expect(parsed.username).toBe(`hs_${dbName}_owner`);
    expect(parsed.port).toBe(String(boxRow(ref)?.publicPort));
    expect(parsed.pathname).toBe(`/${dbName}`);
    const user = await withClient(url, async (client) => {
      await client.query("create table notes (body text)");
      await client.query("insert into notes values ('kept')");
      return (await client.query<{ user: string }>("select current_user as user")).rows[0]?.user;
    });
    expect(user).toBe(`hs_${dbName}_owner`);
  });

  it("gives it a session string that works from the host through the pooler", async () => {
    const env = stackEnv();
    const [session] = await connectionStrings(baseUrl, cookie, ref);
    const parsed = new URL(session as string);
    expect(parsed.username).toBe(`hs_${dbName}_owner.${env.POOLER_TENANT_ID}-${ref}`);
    expect(parsed.port).toBe(env.POOLER_PORT_SESSION || "54322");
    const rows = await withClient(
      session as string,
      async (client) => (await client.query("select current_user, current_database()")).rows,
    );
    expect(rows).toEqual([{ current_user: `hs_${dbName}_owner`, current_database: dbName }]);
  });

  it("stops the container on soft delete", async () => {
    const response = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/delete`,
      { confirm: ref },
      cookie,
    );
    expect(response.status).toBe(302);
    expect(container(`hattisar-box-${ref}`)?.running).toBe(false);
  }, 60_000);

  it("starts it again on restore, with the data intact", async () => {
    const response = await postForm(baseUrl, `/_hs/trash/${ref}/restore`, {}, cookie);
    expect(response.status).toBe(302);
    expect(container(`hattisar-box-${ref}`)?.running).toBe(true);
    const bodies = await withClient(url, async (client) =>
      (await client.query<{ body: string }>("select body from notes")).rows.map((r) => r.body),
    );
    expect(bodies).toEqual(["kept"]);
  }, 150_000);

  it("removes container, volume and box on purge", async () => {
    const deleted = await postForm(
      baseUrl,
      `/_hs/projects/${ref}/delete`,
      { confirm: ref },
      cookie,
    );
    expect(deleted.status).toBe(302);
    const purged = await postForm(baseUrl, `/_hs/trash/${ref}/purge`, { confirm: ref }, cookie);
    expect(purged.status).toBe(302);
    expect(container(`hattisar-box-${ref}`)).toBeUndefined();
    expect(volumeExists(`hattisar_box_${ref}`)).toBe(false);
    expect(boxRow(ref)).toBeUndefined();
  }, 60_000);
});

describe("a managed box without projects", () => {
  it(
    "is removed with its container and volume",
    async () => {
      const created = await postForm(baseUrl, "/_hs/managed-boxes", { name: spareBox }, cookie);
      expect(created.status, await created.clone().text()).toBe(302);
      expect(container(`hattisar-box-${spareBox}`)?.running).toBe(true);
      const id = boxRow(spareBox)?.id;
      const removed = await postForm(baseUrl, `/_hs/boxes/${id}/remove`, {}, cookie);
      expect(removed.status).toBe(302);
      expect(container(`hattisar-box-${spareBox}`)).toBeUndefined();
      expect(volumeExists(`hattisar_box_${spareBox}`)).toBe(false);
      expect(boxRow(spareBox)).toBeUndefined();
    },
    BOOT_TIMEOUT,
  );
});

describe("a container without the hattisar.managed label", () => {
  beforeAll(() => {
    docker(["create", "--name", unlabelledContainer, "supabase/postgres:17.6.1.136"]);
  });

  it("is not taken over by a new box of the same name", async () => {
    const response = await postForm(baseUrl, "/_hs/managed-boxes", { name: unlabelledBox }, cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("is already in use");
    expect(container(unlabelledContainer)?.labels).not.toHaveProperty("hattisar.managed");
    expect(volumeExists(`hattisar_box_${unlabelledBox}`)).toBe(false);
    expect(boxRow(unlabelledBox)).toBeUndefined();
  }, 60_000);

  it("is not removed even when a managed box row points at it", async () => {
    registrySql(
      `INSERT INTO boxes (name, kind, dev_only, host, port, admin_user, admin_password_enc, sslmode,
         public_host, public_port, container_name, created_at)
       VALUES (?, 'managed', 0, ?, 5432, 'supabase_admin', 'unused', 'disable', 'localhost', 1, ?, ?)`,
      unlabelledBox,
      unlabelledContainer,
      unlabelledContainer,
      new Date().toISOString(),
    );
    const id = boxRow(unlabelledBox)?.id;
    const response = await postForm(baseUrl, `/_hs/boxes/${id}/remove`, {}, cookie);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("hattisar will not touch it");
    expect(container(unlabelledContainer)).toBeDefined();
    expect(boxRow(unlabelledBox)).toBeDefined();
  });
});
