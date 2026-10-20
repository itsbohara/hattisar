import { describe, expect, it } from "vitest";
import { studioConnectionString } from "../../src/studio/connection.js";

function project(ownerRole: string, ownerPassword: string, sslmode = "disable") {
  return {
    dbName: "spike_b",
    ownerRole,
    ownerPassword: () => ownerPassword,
    box: {
      host: "db",
      port: 5432,
      sslmode,
      adminUser: "supabase_admin",
      adminPassword: "admin-secret",
    },
  };
}

describe("studioConnectionString", () => {
  it("connects as the project's owner role at the box's internal address", () => {
    expect(studioConnectionString(project("hs_spike_b_owner", "secret"))).toBe(
      "postgresql://hs_spike_b_owner:secret@db:5432/spike_b",
    );
  });

  it("never carries the box admin's credentials", () => {
    const url = studioConnectionString(project("hs_spike_b_owner", "secret", "require"));
    expect(url).not.toContain("supabase_admin");
    expect(url).not.toContain("admin-secret");
  });

  it("URL-encodes user and password", () => {
    expect(studioConnectionString(project("ow:ner@x", "p@ss/w:rd#?%"))).toBe(
      "postgresql://ow%3Aner%40x:p%40ss%2Fw%3Ard%23%3F%25@db:5432/spike_b",
    );
  });

  it.each(["require", "verify-full"])("carries sslmode=%s to pg-meta", (sslmode) => {
    expect(studioConnectionString(project("hs_spike_b_owner", "secret", sslmode))).toBe(
      `postgresql://hs_spike_b_owner:secret@db:5432/spike_b?sslmode=${sslmode}`,
    );
  });
});
