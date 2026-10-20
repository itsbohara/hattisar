import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../../src/boxes/admin-client.js";
import { type E1Facts, e1Problems } from "../../src/boxes/e1.js";

const compatible: E1Facts = {
  serverVersionNum: 170006,
  roles: ["supabase_admin", "anon", "authenticated", "service_role"],
  availableExtensions: ["pgcrypto", "uuid-ossp", "pg_stat_statements"],
  adminUser: "supabase_admin",
  superuser: true,
};

describe("e1Problems", () => {
  it("finds nothing wrong with a Supabase Postgres", () => {
    expect(e1Problems(compatible)).toEqual([]);
  });

  it("lists every unmet item of a plain old Postgres", () => {
    expect(
      e1Problems({
        serverVersionNum: 140010,
        roles: [],
        availableExtensions: ["pgcrypto"],
        adminUser: "app",
        superuser: false,
      }),
    ).toEqual([
      "Postgres 15 or newer is required; this server is version 14",
      "Missing role: supabase_admin",
      "Missing role: anon",
      "Missing role: authenticated",
      "Missing role: service_role",
      "Extension not available: uuid-ossp",
      "Extension not available: pg_stat_statements",
      "Admin user app is not a superuser",
    ]);
  });

  it("rejects a non-superuser admin", () => {
    expect(e1Problems({ ...compatible, superuser: false })).toEqual([
      "Admin user supabase_admin is not a superuser",
    ]);
  });

  it("accepts exactly Postgres 15", () => {
    expect(e1Problems({ ...compatible, serverVersionNum: 150000 })).toEqual([]);
  });
});

describe("safeErrorMessage", () => {
  it("scrubs the password from a driver message", () => {
    const error = new Error('password "hunter2-secret" rejected');
    expect(safeErrorMessage(error, "hunter2-secret")).toBe('password "********" rejected');
  });
});
