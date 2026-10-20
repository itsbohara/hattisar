import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isS3Configured,
  loadS3Settings,
  type S3Form,
  type S3Settings,
  saveS3Settings,
  storedS3Form,
  validateS3Form,
} from "../../src/backups/s3-settings.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import { deriveSecretKey } from "../../src/registry/secrets.js";
import { getSetting } from "../../src/registry/settings.js";

const secretKey = deriveSecretKey("a-test-secret-key-that-is-long-enough");
let dataDir: string;
let db: Registry;

const form: S3Form = {
  endpoint: "http://s3:9000",
  region: "us-east-1",
  bucket: "hattisar-backups",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI-secret",
  forcePathStyle: true,
  prefix: "/team/dbs/",
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-s3-"));
  db = openRegistry(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function valid(input: S3Form): S3Settings {
  const result = validateS3Form(db, secretKey, input);
  if (Array.isArray(result)) throw new Error(result.join("; "));
  return result;
}

describe("S3 settings", () => {
  it("starts unconfigured with the default prefix", () => {
    expect(isS3Configured(db)).toBe(false);
    expect(loadS3Settings(db, secretKey)).toBeUndefined();
    expect(storedS3Form(db)).toEqual({
      values: {
        endpoint: "",
        region: "",
        bucket: "",
        accessKeyId: "",
        forcePathStyle: false,
        prefix: "hattisar",
      },
      secretSet: false,
    });
  });

  it("round-trips, normalizing the prefix and encrypting the secret", () => {
    saveS3Settings(db, secretKey, valid(form));
    expect(loadS3Settings(db, secretKey)).toEqual({
      endpoint: "http://s3:9000",
      region: "us-east-1",
      bucket: "hattisar-backups",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI-secret",
      forcePathStyle: true,
      prefix: "team/dbs",
    });
    expect(getSetting(db, "s3.secret_access_key_enc")).toMatch(/^v1:/);
    const stored = db.prepare("SELECT group_concat(value) AS v FROM settings").get() as {
      v: string;
    };
    expect(stored.v).not.toContain(form.secretAccessKey);
    expect(storedS3Form(db).secretSet).toBe(true);
  });

  it("keeps the stored secret when the field is left blank", () => {
    saveS3Settings(db, secretKey, valid(form));
    saveS3Settings(db, secretKey, valid({ ...form, secretAccessKey: "", region: "eu-west-1" }));
    expect(loadS3Settings(db, secretKey)).toMatchObject({
      region: "eu-west-1",
      secretAccessKey: form.secretAccessKey,
    });
  });

  it("treats a blank endpoint as AWS S3", () => {
    saveS3Settings(db, secretKey, valid(form));
    saveS3Settings(db, secretKey, valid({ ...form, endpoint: "", secretAccessKey: "" }));
    expect(loadS3Settings(db, secretKey)?.endpoint).toBeUndefined();
    expect(storedS3Form(db).values.endpoint).toBe("");
  });

  it("reports every problem at once", () => {
    expect(
      validateS3Form(db, secretKey, {
        endpoint: "ftp://x",
        region: "",
        bucket: "Bad_Bucket",
        accessKeyId: "",
        secretAccessKey: "",
        forcePathStyle: false,
        prefix: "a//b",
      }),
    ).toEqual([
      "Endpoint must be an http(s) URL, or blank for AWS S3",
      "Region is required",
      "Bucket must be 3-63 characters: lowercase letters, digits, dots and hyphens",
      "Access key ID is required",
      "Secret access key is required",
      "Key prefix may contain letters, digits, dots, hyphens and underscores, separated by /",
    ]);
  });
});
