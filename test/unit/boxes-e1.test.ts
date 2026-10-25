import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../../src/boxes/admin-client.js";
import { type E1Facts, e1Problems } from "../../src/boxes/e1.js";

const compatible: E1Facts = {
  serverVersionNum: 170006,
  availableExtensions: ["pgcrypto", "uuid-ossp", "pg_stat_statements"],
  adminUser: "supabase_admin",
  superuser: true,
  createdb: true,
  createrole: true,
};

const NEEDS_PRIVILEGES =
  "Admin user supabase_admin needs to be a superuser, or have CREATEDB and CREATEROLE";

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
        createdb: false,
        createrole: false,
      }),
    ).toEqual([
      "Postgres 15 or newer is required; this server is version 14",
      "Extension not available: uuid-ossp",
      "Extension not available: pg_stat_statements",
      "Admin user app needs to be a superuser, or have CREATEDB and CREATEROLE",
    ]);
  });

  it("accepts a superuser admin whatever its other attributes", () => {
    expect(e1Problems({ ...compatible, createdb: false, createrole: false })).toEqual([]);
  });

  it("accepts a non-superuser admin with CREATEDB and CREATEROLE", () => {
    expect(e1Problems({ ...compatible, superuser: false })).toEqual([]);
  });

  it.each([
    { createdb: true, createrole: false },
    { createdb: false, createrole: true },
    { createdb: false, createrole: false },
  ])("rejects a non-superuser admin with %o", (attributes) => {
    expect(e1Problems({ ...compatible, superuser: false, ...attributes })).toEqual([
      NEEDS_PRIVILEGES,
    ]);
  });

  it("accepts exactly Postgres 15", () => {
    expect(e1Problems({ ...compatible, serverVersionNum: 150000 })).toEqual([]);
  });

  it("accepts Postgres 18", () => {
    expect(e1Problems({ ...compatible, serverVersionNum: 180000 })).toEqual([]);
  });

  it("refuses Postgres 19, which the bundled pg_dump 18 cannot back up", () => {
    expect(e1Problems({ ...compatible, serverVersionNum: 190000 })).toEqual([
      "Postgres 18 or older is required; this server is version 19",
    ]);
  });
});

describe("safeErrorMessage", () => {
  it("scrubs the password from a driver message", () => {
    const error = new Error('password "hunter2-secret" rejected');
    expect(safeErrorMessage(error, "hunter2-secret")).toBe('password "********" rejected');
  });
});
