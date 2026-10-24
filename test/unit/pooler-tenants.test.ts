import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AdminClientRunner } from "../../src/boxes/admin-client.js";
import { installPoolerRole } from "../../src/pooler/role.js";
import {
  SupavisorError,
  type TenantApi,
  type TenantBody,
  type TenantInfo,
} from "../../src/pooler/supavisor.js";
import { createPoolerTenants } from "../../src/pooler/tenants.js";
import {
  type Box,
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
}));

const secretKey = deriveSecretKey("p".repeat(32));
const install = vi.mocked(installPoolerRole);

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

function service(ports = { portSession: 54322, portTransaction: 6543 }) {
  return createPoolerTenants({ db, secretKey, api, admin, tenantPrefix: "hattisar", ...ports });
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
    const password = install.mock.calls[0]?.[1];
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.puts).toHaveLength(1);
    const put = api.puts[0];
    expect(put?.id).toBe("hattisar-b1");
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
  });

  it("keeps the fields null and warns without the password when the PUT fails", async () => {
    const box = addBox();
    api.putError = new SupavisorError("Supavisor PUT failed: bad", 400);
    install.mockImplementationOnce(async () => {
      api.putError = new SupavisorError(`Supavisor PUT failed: ${install.mock.calls[0]?.[1]}`, 400);
    });

    await expect(service().ensure(box)).resolves.toBeUndefined();

    const password = install.mock.calls[0]?.[1] as string;
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(password);
    expect(String(warn.mock.calls[0]?.[0])).toContain("b1");
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

  it("puts the tenant without users when the host differs", async () => {
    const box = withTenant();
    api.tenants.set("hattisar-b1", { dbHost: "db.old", dbPort: 5432 });
    await service().ensure(box);
    expect(adminCalls).toEqual([]);
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]?.id).toBe("hattisar-b1");
    expect(api.puts[0]?.tenant.db_host).toBe("db.b1");
    expect(api.puts[0]?.tenant).not.toHaveProperty("users");
  });

  it("recreates a missing tenant with a new password under the same id", async () => {
    const box = withTenant({ name: "renamed", poolerSessionPort: 1, poolerTransactionPort: 2 });
    await service().ensure(box);
    expect(adminCalls).toHaveLength(1);
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]?.id).toBe("hattisar-b1");
    expect(api.puts[0]?.tenant.users?.[0]?.db_password).toBe(install.mock.calls[0]?.[1]);
    expect(poolerFields(box.id)).toEqual({
      poolerTenant: "hattisar-b1",
      poolerSessionPort: 54322,
      poolerTransactionPort: 6543,
    });
  });

  it("keeps the stored id when the box is renamed", async () => {
    const box = withTenant();
    updateBox(db, box.id, { name: "renamed", host: "db.renamed" });
    api.tenants.set("hattisar-b1", { dbHost: "db.b1", dbPort: 5432 });
    await service().ensure(getBoxById(db, box.id) as Box);
    expect(api.puts.map((put) => put.id)).toEqual(["hattisar-b1"]);
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

describe("drop", () => {
  it("removes the tenant and clears the fields", async () => {
    const box = withTenant();
    await service().drop(box);
    expect(api.removed).toEqual(["hattisar-b1"]);
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
  });

  it("clears the fields and warns when the removal fails", async () => {
    const box = withTenant();
    api.removeError = new SupavisorError("Supavisor unreachable", 0);
    await expect(service().drop(box)).resolves.toBeUndefined();
    expect(poolerFields(box.id)).toEqual(NO_POOLER);
    expect(warn).toHaveBeenCalledTimes(1);
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
    expect(poolerFields(shared.id).poolerTenant).toBe("hattisar");
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
    ]);
    expect(poolerFields(first.id).poolerTenant).toBe("hattisar-a1");
    expect(poolerFields(second.id).poolerTenant).toBe("hattisar-b1");
    expect(poolerFields(tls.id)).toEqual(NO_POOLER);
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
