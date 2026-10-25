import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../../src/boxes/admin-client.js";
import { type E1Facts, e1Problems } from "../../src/boxes/e1.js";

const compatible: E1Facts = {
  serverVersionNum: 170006,
  availableExtensions: ["pgcrypto", "uuid-ossp", "pg_stat_statements"],
  adminUser: "supabase_admin",
  superuser: true,
};

describe("e1Problems", () => {
  it("finds nothing wrong with a plain Postgres 17 without Supabase roles", () => {
    expect(e1Problems(compatible)).toEqual([]);
  });

  it("lists every unmet item of an old Postgres", () => {
    expect(
      e1Problems({
        serverVersionNum: 140010,
        availableExtensions: ["pgcrypto"],
        adminUser: "app",
        superuser: false,
      }),
    ).toEqual([
      "Postgres 15 or newer is required; this server is version 14",
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

  it("accepts the last Postgres 17", () => {
    expect(e1Problems({ ...compatible, serverVersionNum: 179999 })).toEqual([]);
  });

  it("refuses Postgres 18, which the bundled pg_dump 17 cannot back up", () => {
    expect(e1Problems({ ...compatible, serverVersionNum: 180000 })).toEqual([
      "Postgres 17 or older is required; this server is version 18",
    ]);
  });
});

describe("safeErrorMessage", () => {
  it("scrubs the password from a driver message", () => {
    const error = new Error('password "hunter2-secret" rejected');
    expect(safeErrorMessage(error, "hunter2-secret")).toBe('password "********" rejected');
  });
});
