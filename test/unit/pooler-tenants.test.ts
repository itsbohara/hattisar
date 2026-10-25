import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { dropPoolerRole, installPoolerRole, poolerRoleFor } from "../../src/pooler/role.js";
import {
  SupavisorError,
  type TenantApi,
  type TenantBody,
  type TenantInfo,
} from "../../src/pooler/supavisor.js";
import { createPoolerTenants } from "../../src/pooler/tenants.js";
import {
  type Box,
  deleteBox,
  getBoxById,
  insertBox,
  type NewBox,
  updateBox,
} from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { deriveSecretKey, encryptSecret } from "../../src/registry/secrets.js";

vi.mock("../../src/pooler/role.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pooler/role.js")>()),
  installPoolerRole: vi.fn(async () => undefined),
  dropPoolerRole: vi.fn(async () => undefined),
}));

const secretKey = deriveSecretKey("p".repeat(32));
const install = vi.mocked(installPoolerRole);
const dropRole = vi.mocked(dropPoolerRole);

class FakeApi implements TenantApi {
  tenants = new Map<string, TenantInfo>();
  calls: string[] = [];
  puts: { id: string; tenant: TenantBody; scrub?: string }[] = [];
  removed: string[] = [];
  getError: Error | undefined;
  getErrorFor = new Set<string>();
  putError: Error | undefined;
  removeError: Error | undefined;

  async get(id: string): Promise<TenantInfo | undefined> {
    this.calls.push(`get ${id}`);
    if (this.getError !== undefined || this.getErrorFor.has(id)) {
      throw this.getError ?? new SupavisorError("Supavisor unreachable", 0);
    }
    return this.tenants.get(id);
  }

  async put(id: string, tenant: TenantBody, scrub?: string): Promise<void> {
    this.calls.push(`put ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.putError !== undefined) throw this.putError;
    this.puts.push({ id, tenant, scrub });
    this.tenants.set(id, { dbHost: tenant.db_host, dbPort: tenant.db_port });
  }

  async remove(id: string): Promise<void> {
    this.calls.push(`remove ${id}`);
    if (this.removeError !== undefined) throw this.removeError;
    this.removed.push(id);
    this.tenants.delete(id);
  }
}

let dataDir: string;
let db: Registry;
let api: FakeApi;
let adminCalls: { host: string; database: string | undefined }[];
let warn: MockInstance<typeof console.warn>;

const admin: AdminClientRunner = async (conn, run, database) => {
  adminCalls.push({ host: conn.host, database });
  api.calls.push(`admin ${conn.host}`);
  return run({} as pg.Client);
};

function service(ports = { portSession: 54322, portTransaction: 6543 }, tenantPrefix = "hattisar") {
  return createPoolerTenants({ db, secretKey, api, admin, tenantPrefix, ...ports });
}

function addBox(overrides: Partial<NewBox> = {}): Box {
  return insertBox(db, {
    name: "b1",
    kind: "registered",
    devOnly: false,
    host: "db.b1",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: encryptSecret("admin-pw", secretKey),
    sslmode: "disable",
    publicHost: "db.b1",
    publicPort: 5432,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
    adminSuperuser: true,
    ...overrides,
  });
}

function withTenant(overrides: Partial<NewBox> = {}): Box {
  return addBox({
    poolerTenant: "hattisar-b1",
    poolerSessionPort: 54322,
    poolerTransactionPort: 6543,
    ...overrides,
  });
}

function poolerFields(id: number) {
  const box = getBoxById(db, id);
  return {
    poolerTenant: box?.poolerTenant,
    poolerSessionPort: box?.poolerSessionPort,
    poolerTransactionPort: box?.poolerTransactionPort,
  };
}

const NO_POOLER = { poolerTenant: null, poolerSessionPort: null, poolerTransactionPort: null };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-tenants-"));
  db = openRegistry(dataDir);
  api = new FakeApi();
  adminCalls = [];
  install.mockClear();
  dropRole.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ensure on a new eligible box", () => {
  it("installs the role in postgres, puts the full tenant, then stores the fields", async () => {
    const box = addBox();
    await service().ensure(box);

    expect(adminCalls).toEqual([{ host: "db.b1", database: "postgres" }]);
    expect(install).toHaveBeenCalledTimes(1);
    const password = install.mock.calls[0]?.[2];
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.puts).toHaveLength(1);
    const put = api.puts[0];
    expect(put?.id).toBe("hattisar-b1");
    expect(install.mock.calls[0]?.[1]).toBe(poolerRoleFor(secretKey, "hattisar-b1"));
    expect(put?.tenant.users?.[0]?.db_user).toBe(poolerRoleFor(secretKey, "hattisar-b1"));
    expect(put?.tenant.users?.[0]?.db_password).toBe(password);
    expect(put?.scrub).toBe(password);
    expect(api.calls).toEqual(["admin db.b1", "put hattisar-b1"]);
    expect(poolerFields(box.id)).toEqual({
      poolerTenant: "hattisar-b1",
      poolerSessionPort: 54322,
      poolerTransactionPort: 6543,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("takes the id-suffixed tenant id when another box stores the plain one", async () => {
    addBox({ name: "other", host: "db.other", poolerTenant: "hattisar-b1" });
    const box = addBox();
    await service().ensure(box);
    expect(poolerFields(box.id).poolerTenant).toBe(`hattisar-b1-${box.id}`);
    expect(install.mock.calls[0]?.[1]).toBe(poolerRoleFor(secretKey, `hattisar-b1-${box.id}`));
  });

  it("keeps the fields null and warns without the password when the PUT fails", async () => {
    const box = addBox();
    api.putError = new SupavisorError("Supavisor PUT failed: bad", 400);
    install.mockImplementationOnce(async () => {
      api.putError = new SupavisorError(`Supavisor PUT failed: ${install.mock.calls[0]?.[2]}`, 400);
    });

    await expect(service().ensure(box)).resolves.toBeUndefined();

    const password = install.mock.calls[0]?.[2] as string;
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(password);
    expect(String(warn.mock.calls[0]?.[0])).toContain("b1");
  });

  it("never installs a role for an invalid tenant id", async () => {
    const box = addBox();
    await expect(
      service({ portSession: 54322, portTransaction: 6543 }, "bad.prefix").ensure(box),
    ).resolves.toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("scrubs the box admin password from the warning", async () => {
    const box = addBox();
    install.mockRejectedValueOnce(new Error("auth failed for admin-pw"));
    await service().ensure(box);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("admin-pw");
  });

  it("keeps the fields null and warns when installing the role fails", async () => {
    const box = addBox();
    install.mockRejectedValueOnce(new Error("connection refused"));
    await expect(service().ensure(box)).resolves.toBeUndefined();
    expect(api.puts).toHaveLength(0);
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("ensure on a box with a stored tenant", () => {
  it("does nothing when the tenant matches", async () => {
    const box = withTenant();
    api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });
    await service().ensure(box);
    expect(api.calls).toEqual(["get hattisar-b1"]);
    expect(adminCalls).toEqual([]);
  });

  it("recreates the tenant with its role on the box's server when the host differs", async () => {
    const box = withTenant();
    api.tenants.set("hattisar-b1", { dbHost: "db.old", dbPort: 5432 });
    await service().ensure(box);
    expect(adminCalls).toEqual([{ host: "db.b1", database: "postgres" }]);
    expect(install.mock.calls[0]?.[1]).toBe(poolerRoleFor(secretKey, "hattisar-b1"));
    expect(api.calls).toEqual(["get hattisar-b1", "admin db.b1", "put hattisar-b1"]);
    expect(api.puts[0]?.tenant.db_host).toBe("db.b1");
    expect(api.puts[0]?.tenant.users?.[0]?.db_password).toBe(install.mock.calls[0]?.[2]);
    expect(poolerFields(box.id).poolerTenant).toBe("hattisar-b1");
  });

  it("recreates a missing tenant with a new password under the same id", async () => {
    const box = withTenant({ name: "renamed", poolerSessionPort: 1, poolerTransactionPort: 2 });
    await service().ensure(box);
    expect(adminCalls).toHaveLength(1);
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]?.id).toBe("hattisar-b1");
    expect(api.puts[0]?.tenant.users?.[0]?.db_password).toBe(install.mock.calls[0]?.[2]);
    expect(poolerFields(box.id)).toEqual({
      poolerTenant: "hattisar-b1",
      poolerSessionPort: 54322,
      poolerTransactionPort: 6543,
    });
  });

  it("keeps the stored id when the box is renamed", async () => {
    const box = withTenant();
    updateBox(db, box.id, { name: "renamed" });
    api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });
    await service().ensure(getBoxById(db, box.id) as Box);
    expect(api.calls).toEqual(["get hattisar-b1"]);
    expect(poolerFields(box.id).poolerTenant).toBe("hattisar-b1");
  });

  it("warns and keeps the fields when the GET fails", async () => {
    const box = withTenant();
    api.getError = new SupavisorError("Supavisor GET failed: unexpected response", 200);
    await expect(service().ensure(box)).resolves.toBeUndefined();
    expect(api.puts).toHaveLength(0);
    expect(poolerFields(box.id).poolerTenant).toBe("hattisar-b1");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops the tenant of a box that is no longer eligible", async () => {
    const box = withTenant({ sslmode: "require" });
    api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });
    await service().ensure(box);
    expect(api.removed).toEqual(["hattisar-b1"]);
    expect(api.puts).toHaveLength(0);
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
  });
});

it("does nothing for an ineligible box without a tenant", async () => {
  const box = addBox({ sslmode: "verify-full" });
  await service().ensure(box);
  expect(api.calls).toEqual([]);
});

it("serializes concurrent ensures for one box", async () => {
  const box = addBox();
  const tenants = service();
  await Promise.all([tenants.ensure(box), tenants.ensure(box)]);
  expect(api.puts).toHaveLength(1);
  expect(adminCalls).toHaveLength(1);
});

it("does not recreate the tenant of a box deleted after a drop", async () => {
  const box = withTenant();
  api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });
  const tenants = service();
  await tenants.drop(box);
  deleteBox(db, box.id);
  await tenants.ensure(box);
  expect(install).not.toHaveBeenCalled();
  expect(api.puts).toHaveLength(0);
  expect(api.calls).toEqual(["remove hattisar-b1", "admin db.b1"]);
});

describe("drop", () => {
  it("removes the tenant, clears the fields, then drops a registered box's role", async () => {
    const box = withTenant();
    await service().drop(box);
    expect(api.removed).toEqual(["hattisar-b1"]);
    expect(api.calls).toEqual(["remove hattisar-b1", "admin db.b1"]);
    expect(adminCalls).toEqual([{ host: "db.b1", database: "postgres" }]);
    expect(dropRole).toHaveBeenCalledTimes(1);
    expect(dropRole.mock.calls[0]?.[1]).toBe(poolerRoleFor(secretKey, "hattisar-b1"));
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).not.toHaveBeenCalled();
  });

  it("clears the fields and warns when the removal fails", async () => {
    const box = withTenant();
    api.removeError = new SupavisorError("Supavisor unreachable", 0);
    await expect(service().drop(box)).resolves.toBeUndefined();
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(dropRole).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clears the fields and warns when dropping the role fails", async () => {
    const box = withTenant();
    dropRole.mockRejectedValueOnce(new Error("connection refused for admin-pw"));
    await expect(service().drop(box)).resolves.toBeUndefined();
    expect(api.removed).toEqual(["hattisar-b1"]);
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("connection refused");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("admin-pw");
  });

  it("leaves a managed box's role alone", async () => {
    const box = withTenant({ kind: "managed" });
    await service().drop(box);
    expect(api.removed).toEqual(["hattisar-b1"]);
    expect(adminCalls).toEqual([]);
    expect(dropRole).not.toHaveBeenCalled();
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
  });

  it("does nothing for a box without a tenant", async () => {
    const box = addBox();
    await service().drop(box);
    expect(api.calls).toEqual([]);
  });
});

describe("reconcile", () => {
  it("skips the shared box", async () => {
    const shared = addBox({ name: "shared", kind: "shared", host: "db", poolerTenant: "hattisar" });
    await service().reconcile();
    expect(api.calls).toEqual([]);
    expect(poolerFields(shared.id)).toEqual({
      poolerTenant: "hattisar",
      poolerSessionPort: null,
      poolerTransactionPort: null,
    });
  });

  it("rewrites the ports from config on boxes with a tenant", async () => {
    const box = withTenant();
    api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });
    await service({ portSession: 5000, portTransaction: 6000 }).reconcile();
    expect(api.puts).toHaveLength(0);
    expect(poolerFields(box.id)).toEqual({
      poolerTenant: "hattisar-b1",
      poolerSessionPort: 5000,
      poolerTransactionPort: 6000,
    });
  });

  it("ensures eligible boxes and drops ineligible ones, one after another", async () => {
    const first = addBox({ name: "a1", host: "db.a1" });
    const second = addBox({ name: "b1", host: "db.b1" });
    const tls = withTenant({
      name: "c1",
      host: "db.c1",
      poolerTenant: "hattisar-c1",
      sslmode: "require",
    });
    await service().reconcile();
    expect(api.calls).toEqual([
      "admin db.a1",
      "put hattisar-a1",
      "admin db.b1",
      "put hattisar-b1",
      "remove hattisar-c1",
      "admin db.c1",
    ]);
    expect(poolerFields(first.id).poolerTenant).toBe("hattisar-a1");
    expect(poolerFields(second.id).poolerTenant).toBe("hattisar-b1");
    expect(poolerFields(tls.id)).toEqual(NO_POOLER);
  });

  it("does not set ports on a box dropped while reconcile ran", async () => {
    const first = addBox({ name: "a1", host: "db.a1" });
    const later = withTenant({
      name: "b1",
      host: "db.b1",
      sslmode: "require",
      poolerSessionPort: 1,
    });
    const tenants = service();
    install.mockImplementationOnce(async () => {
      updateBox(db, later.id, NO_POOLER);
    });
    await tenants.reconcile();
    expect(poolerFields(first.id).poolerTenant).toBe("hattisar-a1");
    expect(poolerFields(later.id)).toEqual(NO_POOLER);
  });

  it("goes on with the next box when one fails", async () => {
    withTenant({ name: "a1", host: "db.a1", poolerTenant: "hattisar-a1" });
    const next = addBox({ name: "b1", host: "db.b1" });
    api.getErrorFor.add("hattisar-a1");
    await expect(service().reconcile()).resolves.toBeUndefined();
    expect(poolerFields(next.id).poolerTenant).toBe("hattisar-b1");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("resync", () => {
  it("installs a new role password and puts the stored tenant again", async () => {
    const box = withTenant({ kind: "managed", name: "renamed" });
    api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });

    await expect(service().resync(box)).resolves.toEqual({ ok: true, tenant: "hattisar-b1" });

    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[1]).toBe(poolerRoleFor(secretKey, "hattisar-b1"));
    expect(api.calls).toEqual(["admin db.b1", "put hattisar-b1"]);
    expect(api.puts[0]?.tenant.users?.[0]?.db_password).toBe(install.mock.calls[0]?.[2]);
    expect(poolerFields(box.id).poolerTenant).toBe("hattisar-b1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("creates a tenant for a box without one and stores the fields", async () => {
    addBox({ name: "other", host: "db.other", poolerTenant: "hattisar-b1" });
    const box = addBox();

    await expect(service().resync(box)).resolves.toEqual({
      ok: true,
      tenant: `hattisar-b1-${box.id}`,
    });

    expect(api.puts.map((put) => put.id)).toEqual([`hattisar-b1-${box.id}`]);
    expect(poolerFields(box.id)).toEqual({
      poolerTenant: `hattisar-b1-${box.id}`,
      poolerSessionPort: 54322,
      poolerTransactionPort: 6543,
    });
  });

  it("refuses the shared box", async () => {
    const shared = addBox({ name: "shared", kind: "shared", host: "db", poolerTenant: "hattisar" });
    await expect(service().resync(shared)).resolves.toEqual({
      ok: false,
      reason: "refused",
      problem: "The shared box's pooler is configured by pooler.exs.",
    });
    expect(api.calls).toEqual([]);
  });

  it("refuses a registered box that requires TLS", async () => {
    const box = addBox({ sslmode: "verify-full" });
    await expect(service().resync(box)).resolves.toEqual({
      ok: false,
      reason: "refused",
      problem: "This box has no pooler: it requires TLS.",
    });
    expect(api.calls).toEqual([]);
  });

  it("reports a scrubbed problem and keeps the fields when the PUT fails", async () => {
    const box = withTenant({ poolerSessionPort: 1, poolerTransactionPort: 2 });
    install.mockImplementationOnce(async () => {
      const password = install.mock.calls[0]?.[2];
      api.putError = new SupavisorError(`Supavisor PUT failed: ${password} admin-pw`, 400);
    });

    const result = await service().resync(box);

    const password = install.mock.calls[0]?.[2] as string;
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    const problem = result.ok ? "" : result.problem;
    expect(problem).toMatch(/^Pooler tenant not re-synced: Supavisor PUT failed: /);
    expect(problem).not.toContain(password);
    expect(problem).not.toContain("admin-pw");
    expect(poolerFields(box.id)).toEqual({
      poolerTenant: "hattisar-b1",
      poolerSessionPort: 1,
      poolerTransactionPort: 2,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports Box not found when the row is deleted while queued", async () => {
    const box = withTenant();
    const tenants = service();
    const drop = tenants.drop(box);
    const resync = tenants.resync(box);
    deleteBox(db, box.id);
    await drop;
    await expect(resync).resolves.toEqual({
      ok: false,
      reason: "not-found",
      problem: "Box not found.",
    });
    expect(install).not.toHaveBeenCalled();
    expect(api.puts).toHaveLength(0);
  });

  it("runs after an ensure queued before it and uses the tenant that ensure stored", async () => {
    const other = addBox({ name: "other", host: "db.other", poolerTenant: "hattisar-b1" });
    const box = addBox();
    const stored = `hattisar-b1-${box.id}`;
    // Frees the plain id once ensure has chosen its id: a resync working from the caller's
    // snapshot would then pick "hattisar-b1" instead of the stored tenant.
    install.mockImplementationOnce(async () => {
      updateBox(db, other.id, NO_POOLER);
    });
    const tenants = service();
    const [, result] = await Promise.all([tenants.ensure(box), tenants.resync(box)]);
    expect(result).toEqual({ ok: true, tenant: stored });
    expect(api.calls).toEqual(["admin db.b1", `put ${stored}`, "admin db.b1", `put ${stored}`]);
    expect(install.mock.calls[1]?.[2]).not.toBe(install.mock.calls[0]?.[2]);
  });

  it("still runs when the step queued before it rejected", async () => {
    const box = addBox();
    const tenants = service();
    install.mockRejectedValueOnce(new Error("connection refused"));
    warn.mockImplementation(() => {
      throw new Error("log failed");
    });
    const ensure = tenants.ensure(box);
    const resync = tenants.resync(box);
    await expect(ensure).rejects.toThrow("log failed");
    await expect(resync).resolves.toEqual({ ok: true, tenant: "hattisar-b1" });
  });
});
