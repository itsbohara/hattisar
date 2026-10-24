import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoxConnection } from "../../src/boxes/admin-client.js";
import type { E1Result } from "../../src/boxes/e1.js";
import { boxRoutes } from "../../src/boxes/routes.js";
import { seedSharedBox } from "../../src/boxes/shared.js";
import { loadConfig } from "../../src/config.js";
import { getBoxByName, getSharedBox, listBoxes } from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { insertProject } from "../../src/registry/projects.js";
import { decryptSecret, deriveSecretKey } from "../../src/registry/secrets.js";
import { RecordingPooler } from "../helpers/pooler.js";

const secretKey = deriveSecretKey("b".repeat(32));
const PASSWORD = "box-admin-password-not-echoed";

let dataDir: string;
let db: Registry;
let checked: BoxConnection[];
let nextResult: E1Result;
let pooler: RecordingPooler;
let app: ReturnType<typeof boxRoutes>;

function config(env: Record<string, string> = {}) {
  return loadConfig({
    HATTISAR_SECRET_KEY: "b".repeat(32),
    PG_META_CRYPTO_KEY: "unit",
    POSTGRES_PASSWORD: "shared-password",
    POOLER_TENANT_ID: "hattisar",
    POOLER_JWT_SECRET: "pooler-jwt-secret",
    HATTISAR_PUBLIC_HOST: "db.example.test",
    ...env,
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-boxes-"));
  db = openRegistry(dataDir);
  checked = [];
  nextResult = { ok: true, problems: [] };
  pooler = new RecordingPooler(db);
  app = boxRoutes({
    db,
    secretKey,
    pooler,
    check: async (conn) => {
      checked.push(conn);
      return nextResult;
    },
  });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const form = {
  name: "prod-eu",
  host: "pg.internal",
  port: "5432",
  adminUser: "supabase_admin",
  adminPassword: PASSWORD,
  sslmode: "require",
  publicHost: "pg.example.test",
  publicPort: "6543",
};

async function post(path: string, fields: Record<string, string>): Promise<Response> {
  return app.request(path, { method: "POST", body: new URLSearchParams(fields) });
}

describe("seedSharedBox", () => {
  it("seeds the shared box once and refreshes it from env on later boots", () => {
    seedSharedBox(db, config(), secretKey);
    seedSharedBox(
      db,
      config({ POSTGRES_PASSWORD: "rotated", POOLER_PORT_SESSION: "15432" }),
      secretKey,
    );

    expect(listBoxes(db)).toHaveLength(1);
    const shared = getSharedBox(db);
    expect(shared).toMatchObject({
      name: "shared",
      kind: "shared",
      devOnly: true,
      host: "db",
      port: 5432,
      adminUser: "supabase_admin",
      sslmode: "disable",
      publicHost: "db.example.test",
      publicPort: 15432,
      poolerTenant: "hattisar",
      poolerSessionPort: 15432,
      poolerTransactionPort: 6543,
    });
    expect(decryptSecret(shared?.adminPasswordEnc ?? "", secretKey)).toBe("rotated");
  });
});

describe("registering a box", () => {
  it("stores a box that passes E1 with its password encrypted", async () => {
    const response = await post("/_hs/boxes", { ...form, devOnly: "on" });
    expect(response.status).toBe(302);
    expect(checked).toEqual([
      {
        host: "pg.internal",
        port: 5432,
        user: "supabase_admin",
        password: PASSWORD,
        sslmode: "require",
      },
    ]);
    const box = getBoxByName(db, "prod-eu");
    expect(box).toMatchObject({ kind: "registered", devOnly: true, publicPort: 6543 });
    expect(box?.adminPasswordEnc).not.toContain(PASSWORD);
    expect(decryptSecret(box?.adminPasswordEnc ?? "", secretKey)).toBe(PASSWORD);
  });

  it("ensures the new box's pooler tenant", async () => {
    await post("/_hs/boxes", form);
    expect(pooler.calls).toEqual([
      { action: "ensure", box: getBoxByName(db, "prod-eu"), rowExists: true },
    ]);
  });

  it("renders every E1 problem with the entered values but never the password", async () => {
    nextResult = { ok: false, problems: ["Missing role: anon", "Missing role: service_role"] };
    const response = await post("/_hs/boxes", form);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("<li>Missing role: anon</li>");
    expect(html).toContain("<li>Missing role: service_role</li>");
    expect(html).toContain('value="pg.internal"');
    expect(html).not.toContain(PASSWORD);
    expect(listBoxes(db)).toEqual([]);
    expect(pooler.calls).toEqual([]);
  });

  it("rejects an invalid name and port without connecting", async () => {
    const response = await post("/_hs/boxes", { ...form, name: "X", port: "70000" });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Name must be");
    expect(html).toContain("Port must be a number between 1 and 65535");
    expect(checked).toEqual([]);
  });

  it("rejects a duplicate name", async () => {
    seedSharedBox(db, config(), secretKey);
    const response = await post("/_hs/boxes", { ...form, name: "shared" });
    expect(await response.text()).toContain("A box named shared already exists");
  });
});

describe("editing and removing", () => {
  async function registered() {
    await post("/_hs/boxes", form);
    const box = getBoxByName(db, "prod-eu");
    if (!box) throw new Error("box not registered");
    return box;
  }

  it("keeps the stored password when the field is blank", async () => {
    const box = await registered();
    const response = await post(`/_hs/boxes/${box.id}`, {
      ...form,
      adminPassword: "",
      publicHost: "new.example.test",
    });
    expect(response.status).toBe(302);
    expect(checked.at(-1)?.password).toBe(PASSWORD);
    const updated = getBoxByName(db, "prod-eu");
    expect(updated?.publicHost).toBe("new.example.test");
    expect(updated?.adminPasswordEnc).toBe(box.adminPasswordEnc);
  });

  it("ensures the pooler tenant against the updated row", async () => {
    const box = await registered();
    pooler.calls = [];
    await post(`/_hs/boxes/${box.id}`, { ...form, sslmode: "disable", host: "pg2.internal" });
    expect(pooler.calls).toEqual([
      { action: "ensure", box: getBoxByName(db, "prod-eu"), rowExists: true },
    ]);
    expect(pooler.calls[0]?.box).toMatchObject({ host: "pg2.internal", sslmode: "disable" });
  });

  it("refuses to remove a box that has projects", async () => {
    const box = await registered();
    insertProject(db, {
      ref: "alpha",
      name: "Alpha",
      boxId: box.id,
      dbName: "alpha",
      ownerRole: "alpha_owner",
      ownerPasswordEnc: "v1:x:y:z",
    });
    pooler.calls = [];
    const response = await post(`/_hs/boxes/${box.id}/remove`, {});
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Box prod-eu still has 1 project");
    expect(getBoxByName(db, "prod-eu")).toBeDefined();
    expect(pooler.calls).toEqual([]);
  });

  it("removes a box without projects, dropping its pooler tenant first", async () => {
    const box = await registered();
    pooler.calls = [];
    expect((await post(`/_hs/boxes/${box.id}/remove`, {})).status).toBe(302);
    expect(getBoxByName(db, "prod-eu")).toBeUndefined();
    expect(pooler.calls).toEqual([{ action: "drop", box, rowExists: true }]);
  });

  it("does not let the UI edit or remove the shared box", async () => {
    seedSharedBox(db, config(), secretKey);
    const shared = getSharedBox(db);
    expect((await app.request(`/_hs/boxes/${shared?.id}/edit`)).status).toBe(404);
    expect((await post(`/_hs/boxes/${shared?.id}/remove`, {})).status).toBe(404);
    expect((await post(`/_hs/boxes/${shared?.id}`, form)).status).toBe(404);
    expect(getSharedBox(db)).toBeDefined();
  });

  it("lists boxes with kind, address, dev-only badge and project count", async () => {
    seedSharedBox(db, config(), secretKey);
    await registered();
    const html = await (await app.request("/_hs/boxes")).text();
    expect(html).toContain("<code>db:5432</code>");
    expect(html).toContain("<code>pg.internal:5432</code>");
    expect(html).toContain("dev only");
    expect(html).toContain("Managed by environment");
  });

  it("shows each box's pooler tenant, pending state or direct-only", async () => {
    seedSharedBox(db, config(), secretKey);
    await post("/_hs/boxes", { ...form, name: "tenanted", sslmode: "disable" });
    db.prepare(
      "UPDATE boxes SET pooler_tenant = 'hattisar-tenanted' WHERE name = 'tenanted'",
    ).run();
    await post("/_hs/boxes", { ...form, name: "pending", sslmode: "disable" });
    await post("/_hs/boxes", { ...form, name: "secure" });
    const html = await (await app.request("/_hs/boxes")).text();
    const row = (name: string) =>
      html.split("<tr").find((chunk) => chunk.includes(`data-box="${name}"`)) ?? "";
    expect(row("shared")).toContain("hattisar");
    expect(row("tenanted")).toContain("hattisar-tenanted");
    expect(row("pending")).toContain("Pooler pending");
    expect(row("secure")).toContain("Direct only");
  });
});
