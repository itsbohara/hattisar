import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const required = {
  HATTISAR_SECRET_KEY: "s".repeat(32),
  PG_META_CRYPTO_KEY: "meta-crypto-key",
  POSTGRES_PASSWORD: "postgres-password",
  POOLER_TENANT_ID: "hattisar",
};

function load(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...required, ...overrides });
}

function errorOf(overrides: Record<string, string | undefined>): ConfigError {
  try {
    load(overrides);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("applies defaults for every optional variable", () => {
    expect(load()).toEqual({
      secretKey: required.HATTISAR_SECRET_KEY,
      adminUsername: "admin",
      adminPassword: undefined,
      publicHost: "localhost",
      port: 8000,
      dataDir: "/data",
      cookieSecure: false,
      purgeAfterDays: 7,
      backupHourUtc: 2,
      pgBinDir: "/usr/bin",
      managedBoxes: false,
      managedPortRange: { start: 55000, end: 55999 },
      dockerHost: "tcp://docker-proxy:2375",
      studioUrl: "http://studio:3000",
      pgMetaUrl: "http://meta:8080",
      pgMetaCryptoKey: required.PG_META_CRYPTO_KEY,
      postgresPassword: required.POSTGRES_PASSWORD,
      pooler: { tenantId: "hattisar", portSession: 54322, portTransaction: 6543 },
      debug: false,
      spikeProjects: [],
    });
  });

  it("reads explicit values", () => {
    const config = load({
      HATTISAR_ADMIN_USERNAME: "root",
      HATTISAR_ADMIN_PASSWORD: "twelve-chars",
      HATTISAR_PUBLIC_HOST: "db.example.com",
      HATTISAR_PORT: "9000",
      HATTISAR_COOKIE_SECURE: "true",
      HATTISAR_PURGE_AFTER_DAYS: "30",
      HATTISAR_BACKUP_HOUR_UTC: "23",
      HATTISAR_MANAGED_BOXES: "true",
      POOLER_PORT_SESSION: "15432",
    });
    expect(config).toMatchObject({
      adminUsername: "root",
      adminPassword: "twelve-chars",
      publicHost: "db.example.com",
      port: 9000,
      cookieSecure: true,
      purgeAfterDays: 30,
      backupHourUtc: 23,
      managedBoxes: true,
      pooler: { portSession: 15432 },
    });
  });

  it("treats an empty string as unset", () => {
    expect(load({ HATTISAR_PORT: "" }).port).toBe(8000);
  });

  it.each(["HATTISAR_SECRET_KEY", "PG_META_CRYPTO_KEY", "POSTGRES_PASSWORD", "POOLER_TENANT_ID"])(
    "fails naming %s when it is missing",
    (name) => {
      expect(errorOf({ [name]: undefined }).message).toBe(`${name} is required`);
    },
  );

  it("rejects a short secret key without echoing it", () => {
    const message = errorOf({ HATTISAR_SECRET_KEY: "too-short" }).message;
    expect(message).toBe("HATTISAR_SECRET_KEY must be at least 32 characters");
  });

  it("rejects a short admin password", () => {
    expect(errorOf({ HATTISAR_ADMIN_PASSWORD: "short" }).message).toBe(
      "HATTISAR_ADMIN_PASSWORD must be at least 12 characters",
    );
  });

  it.each([
    ["HATTISAR_PORT", "0"],
    ["HATTISAR_PORT", "65536"],
    ["HATTISAR_PORT", "80a"],
    ["POOLER_PORT_TRANSACTION", "-1"],
  ])("rejects %s=%s as a port", (name, value) => {
    expect(errorOf({ [name]: value }).message).toBe(`${name} must be a port between 1 and 65535`);
  });

  it("rejects a backup hour outside 0-23", () => {
    expect(errorOf({ HATTISAR_BACKUP_HOUR_UTC: "24" }).message).toBe(
      "HATTISAR_BACKUP_HOUR_UTC must be an integer between 0 and 23",
    );
  });

  it("rejects a non-boolean flag", () => {
    expect(errorOf({ HATTISAR_MANAGED_BOXES: "yes" }).message).toBe(
      'HATTISAR_MANAGED_BOXES must be "true" or "false"',
    );
  });

  it("rejects a malformed service URL", () => {
    expect(errorOf({ STUDIO_URL: "studio:3000" }).message).toBe(
      "STUDIO_URL must be an http(s) URL",
    );
  });

  describe("HATTISAR_MANAGED_PORT_RANGE", () => {
    it("parses start-end", () => {
      expect(load({ HATTISAR_MANAGED_PORT_RANGE: "60000-60010" }).managedPortRange).toEqual({
        start: 60000,
        end: 60010,
      });
    });

    it("accepts a single-port range", () => {
      expect(load({ HATTISAR_MANAGED_PORT_RANGE: "60000-60000" }).managedPortRange).toEqual({
        start: 60000,
        end: 60000,
      });
    });

    it.each(["60000", "60010-60000", "0-10", "60000-70000", "a-b", "1-2-3"])(
      "rejects %s",
      (value) => {
        expect(errorOf({ HATTISAR_MANAGED_PORT_RANGE: value }).message).toBe(
          "HATTISAR_MANAGED_PORT_RANGE must be <start>-<end> with 1 <= start <= end <= 65535",
        );
      },
    );
  });

  it("reads HATTISAR_DEBUG", () => {
    expect(load({ HATTISAR_DEBUG: "true" }).debug).toBe(true);
  });

  describe("HATTISAR_SPIKE_PROJECTS", () => {
    const project = {
      ref: "spike-a",
      name: "Spike A",
      dbName: "spike_a",
      boxName: "shared",
      box: { host: "db", port: 5432, adminUser: "supabase_admin", adminPassword: "hunter2" },
    };

    it("parses a JSON array of projects", () => {
      const spikeProjects = load({
        HATTISAR_SPIKE_PROJECTS: JSON.stringify([project]),
      }).spikeProjects;
      expect(spikeProjects).toEqual([project]);
    });

    it.each([
      ["not JSON", "{"],
      ["not an array", JSON.stringify(project)],
      ["a missing field", JSON.stringify([{ ...project, dbName: undefined }])],
      ["a bad port", JSON.stringify([{ ...project, box: { ...project.box, port: 0 } }])],
      ["a duplicate ref", JSON.stringify([project, project])],
    ])("rejects %s without echoing the value", (_label, value) => {
      const message = errorOf({ HATTISAR_SPIKE_PROJECTS: value }).message;
      expect(message).toBe(
        "HATTISAR_SPIKE_PROJECTS must be a JSON array of projects with unique refs",
      );
      expect(message).not.toContain("hunter2");
    });
  });
});
