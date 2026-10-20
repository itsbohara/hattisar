import { describe, expect, it } from "vitest";
import { adminConnectionString } from "../../src/studio/connection.js";

function project(adminUser: string, adminPassword: string, sslmode = "disable") {
  return {
    dbName: "spike_b",
    box: { host: "db", port: 5432, adminUser, adminPassword, sslmode },
  };
}

describe("adminConnectionString", () => {
  it("builds the Studio connection string format", () => {
    expect(adminConnectionString(project("supabase_admin", "secret"))).toBe(
      "postgresql://supabase_admin:secret@db:5432/spike_b",
    );
  });

  it("URL-encodes user and password", () => {
    expect(adminConnectionString(project("ad:min@x", "p@ss/w:rd#?%"))).toBe(
      "postgresql://ad%3Amin%40x:p%40ss%2Fw%3Ard%23%3F%25@db:5432/spike_b",
    );
  });

  it.each(["require", "verify-full"])("carries sslmode=%s to pg-meta", (sslmode) => {
    expect(adminConnectionString(project("supabase_admin", "secret", sslmode))).toBe(
      `postgresql://supabase_admin:secret@db:5432/spike_b?sslmode=${sslmode}`,
    );
  });
});
