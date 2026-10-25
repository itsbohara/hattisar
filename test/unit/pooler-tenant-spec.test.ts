import { describe, expect, it } from "vitest";
import { POOLER_AUTH_QUERY } from "../../src/pooler/role.js";
import {
  isPoolerEligible,
  poolerStatus,
  tenantBody,
  tenantIdFor,
} from "../../src/pooler/tenant-spec.js";
import type { Box } from "../../src/registry/boxes.js";

function box(overrides: Partial<Box>): Box {
  return {
    id: 7,
    name: "b1",
    kind: "registered",
    devOnly: false,
    host: "db.example",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: "v1:enc",
    sslmode: "disable",
    publicHost: "db.example",
    publicPort: 5432,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
    adminSuperuser: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const WITH_TENANT = {
  poolerTenant: "hattisar-b1",
  poolerSessionPort: 54322,
  poolerTransactionPort: 6543,
};

describe("isPoolerEligible", () => {
  it("accepts managed boxes and registered boxes without TLS", () => {
    expect(isPoolerEligible(box({ kind: "managed" }))).toBe(true);
    expect(isPoolerEligible(box({ kind: "registered" }))).toBe(true);
  });

  it("rejects a registered box whose admin is not a superuser", () => {
    expect(isPoolerEligible(box({ adminSuperuser: false }))).toBe(false);
  });

  it("rejects registered boxes with TLS and the shared box", () => {
    expect(isPoolerEligible(box({ sslmode: "require" }))).toBe(false);
    expect(isPoolerEligible(box({ sslmode: "verify-full" }))).toBe(false);
    expect(isPoolerEligible(box({ kind: "shared" }))).toBe(false);
  });
});

describe("tenantIdFor", () => {
  it("prefixes the box name", () => {
    expect(tenantIdFor("hattisar", { id: 7, name: "b1" }, [])).toBe("hattisar-b1");
  });

  it("appends the box id when the plain id is taken", () => {
    expect(tenantIdFor("hattisar", { id: 7, name: "b1" }, ["hattisar-b1"])).toBe("hattisar-b1-7");
  });
});

describe("tenantBody", () => {
  it("builds the full tenant with the manager user", () => {
    expect(
      tenantBody(
        { host: "hattisar-box-b1", port: 5432 },
        { role: "hattisar_pooler_abc", password: "pw" },
      ),
    ).toEqual({
      db_host: "hattisar-box-b1",
      db_port: 5432,
      db_database: "postgres",
      require_user: false,
      auth_query: POOLER_AUTH_QUERY,
      upstream_ssl: false,
      ip_version: "auto",
      default_pool_size: 20,
      default_max_clients: 100,
      users: [
        {
          db_user: "hattisar_pooler_abc",
          db_password: "pw",
          mode_type: "transaction",
          pool_size: 20,
          is_manager: true,
        },
      ],
    });
  });
});

describe("poolerStatus", () => {
  it("reports the tenant of a shared or eligible box that has one", () => {
    expect(poolerStatus(box({ kind: "shared", ...WITH_TENANT }))).toEqual({
      kind: "tenant",
      id: "hattisar-b1",
    });
    expect(poolerStatus(box({ kind: "managed", ...WITH_TENANT }))).toEqual({
      kind: "tenant",
      id: "hattisar-b1",
    });
  });

  it("reports pending for an eligible box without a tenant", () => {
    expect(poolerStatus(box({ kind: "registered", sslmode: "disable" }))).toEqual({
      kind: "pending",
    });
  });

  it("reports direct for a box that is never pooled", () => {
    expect(poolerStatus(box({ kind: "registered", sslmode: "require" }))).toEqual({
      kind: "direct",
    });
    expect(poolerStatus(box({ kind: "shared" }))).toEqual({ kind: "direct" });
    expect(poolerStatus(box({ sslmode: "disable", adminSuperuser: false }))).toEqual({
      kind: "direct",
    });
    expect(poolerStatus(box({ adminSuperuser: false, ...WITH_TENANT }))).toEqual({
      kind: "direct",
    });
  });
});
