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
  nextResult = { ok: true, problems: [], superuser: true };
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
      adminSuperuser: true,
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
    expect(box).toMatchObject({
      kind: "registered",
      devOnly: true,
      publicPort: 6543,
      adminSuperuser: true,
    });
    expect(box?.adminPasswordEnc).not.toContain(PASSWORD);
    expect(decryptSecret(box?.adminPasswordEnc ?? "", secretKey)).toBe(PASSWORD);
  });

  it("records a non-superuser admin that E1 accepted", async () => {
    nextResult = { ok: true, problems: [], superuser: false };
    expect((await post("/_hs/boxes", form)).status).toBe(302);
    expect(getBoxByName(db, "prod-eu")?.adminSuperuser).toBe(false);
  });

  it("ensures the new box's pooler tenant", async () => {
    await post("/_hs/boxes", form);
    expect(pooler.calls).toEqual([
      { action: "ensure", box: getBoxByName(db, "prod-eu"), rowExists: true },
    ]);
  });

  it("renders every E1 problem with the entered values but never the password", async () => {
    nextResult = {
      ok: false,
      problems: [
        "Extension not available: uuid-ossp",
        "Admin user supabase_admin needs to be a superuser, or have CREATEDB and CREATEROLE",
      ],
      superuser: false,
    };
    const response = await post("/_hs/boxes", form);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("<li>Extension not available: uuid-ossp</li>");
    expect(html).toContain(
      "<li>Admin user supabase_admin needs to be a superuser, or have CREATEDB and CREATEROLE</li>",
    );
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

  it("stores the edited admin's kind before ensuring the pooler", async () => {
    const box = await registered();
    pooler.calls = [];
    nextResult = { ok: true, problems: [], superuser: false };
    await post(`/_hs/boxes/${box.id}`, { ...form, adminUser: "app_admin" });
    expect(getBoxByName(db, "prod-eu")?.adminSuperuser).toBe(false);
    expect(pooler.calls[0]?.box).toMatchObject({ adminSuperuser: false });
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

describe("re-syncing a box's pooler tenant", () => {
  const RESYNC_HINT = "Drops open pooled connections.";

  async function tenanted() {
    await post("/_hs/boxes", { ...form, name: "tenanted", sslmode: "disable" });
    db.prepare(
      "UPDATE boxes SET pooler_tenant = 'hattisar-tenanted' WHERE name = 'tenanted'",
    ).run();
    const box = getBoxByName(db, "tenanted");
    if (!box) throw new Error("box not registered");
    pooler.calls = [];
    return box;
  }

  function rowOf(html: string, name: string): string {
    return html.split("<tr").find((chunk) => chunk.includes(`data-box="${name}"`)) ?? "";
  }

  it("offers Re-sync on boxes with a tenant or a pending one, never on shared or TLS boxes", async () => {
    seedSharedBox(db, config(), secretKey);
    const box = await tenanted();
    await post("/_hs/boxes", { ...form, name: "pending", sslmode: "disable" });
    await post("/_hs/boxes", { ...form, name: "secure" });
    const html = await (await app.request("/_hs/boxes")).text();
    const pending = getBoxByName(db, "pending");
    expect(rowOf(html, "tenanted")).toContain(`action="/_hs/boxes/${box.id}/pooler/resync"`);
    expect(rowOf(html, "tenanted")).toContain(RESYNC_HINT);
    expect(rowOf(html, "pending")).toContain(`action="/_hs/boxes/${pending?.id}/pooler/resync"`);
    expect(rowOf(html, "shared")).not.toContain("pooler/resync");
    expect(rowOf(html, "secure")).not.toContain("pooler/resync");
  });

  it("re-syncs and redirects to the Boxes page, which reports the tenant", async () => {
    const box = await tenanted();
    pooler.resyncResult = { ok: true, tenant: "hattisar-tenanted" };
    const response = await post(`/_hs/boxes/${box.id}/pooler/resync`, {});
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("/_hs/boxes?resynced=hattisar-tenanted");
    expect(pooler.calls).toEqual([{ action: "resync", box, rowExists: true }]);
    const html = await (await app.request(location)).text();
    expect(html).toContain("Re-synced pooler tenant hattisar-tenanted.");
  });

  it("does not report a tenant no box has", async () => {
    const html = await (await app.request("/_hs/boxes?resynced=call-this-number")).text();
    expect(html).not.toContain("Re-synced pooler tenant");
  });

  it.each([
    ["refused", "This box has no pooler: it requires TLS.", 400],
    ["failed", "Pooler tenant not re-synced: unreachable", 502],
  ] as const)("shows a %s re-sync's problem on the Boxes page", async (reason, problem, status) => {
    const box = await tenanted();
    pooler.resyncResult = { ok: false, reason, problem };
    const response = await post(`/_hs/boxes/${box.id}/pooler/resync`, {});
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(problem);
  });

  it("answers 404 for an unknown box or one gone while queued", async () => {
    expect((await post("/_hs/boxes/999/pooler/resync", {})).status).toBe(404);
    expect(pooler.calls).toEqual([]);
    const box = await tenanted();
    pooler.resyncResult = { ok: false, reason: "not-found", problem: "Box not found." };
    expect((await post(`/_hs/boxes/${box.id}/pooler/resync`, {})).status).toBe(404);
  });

  it("does not let the UI re-sync the shared box", async () => {
    seedSharedBox(db, config(), secretKey);
    const shared = getSharedBox(db);
    expect((await post(`/_hs/boxes/${shared?.id}/pooler/resync`, {})).status).toBe(404);
    expect(pooler.calls).toEqual([]);
  });
});
