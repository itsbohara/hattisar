import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/generate-env.sh");
const template = join(root, "docker/env.example");

const secretLengths: Record<string, number> = {
  HATTISAR_SECRET_KEY: 64,
  HATTISAR_ADMIN_PASSWORD: 24,
  PG_META_CRYPTO_KEY: 64,
  POSTGRES_PASSWORD: 48,
  POOLER_SECRET_KEY_BASE: 96,
  POOLER_VAULT_ENC_KEY: 32,
  POOLER_JWT_SECRET: 64,
  S3_TEST_ACCESS_KEY: 20,
  S3_TEST_SECRET_KEY: 40,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hattisar-generate-env-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function generate(target: string): string {
  return execFileSync("sh", [script, template, target], { cwd: tmpdir(), encoding: "utf8" });
}

function values(file: string): Map<string, string> {
  const pairs = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split("=", 2) as [string, string]);
  return new Map(pairs);
}

describe("generate-env.sh", () => {
  it("writes the target with every secret generated", () => {
    const target = join(dir, ".env");

    expect(generate(target).trim()).toBe(`wrote ${target} with generated secrets`);
    expect(readFileSync(target, "utf8")).not.toContain("dev-only-");
    const env = values(target);
    for (const [key, length] of Object.entries(secretLengths)) {
      expect(env.get(key)).toMatch(new RegExp(`^[0-9a-f]{${length}}$`));
    }
  });

  it("generates different secrets on each run", () => {
    generate(join(dir, "a.env"));
    generate(join(dir, "b.env"));

    const a = values(join(dir, "a.env"));
    const b = values(join(dir, "b.env"));
    for (const key of Object.keys(secretLengths)) {
      expect(a.get(key)).not.toBe(b.get(key));
    }
  });

  it("leaves an existing target untouched", () => {
    const target = join(dir, ".env");
    writeFileSync(target, "HATTISAR_SECRET_KEY=keep-me\n");

    expect(generate(target)).toBe("");
    expect(readFileSync(target, "utf8")).toBe("HATTISAR_SECRET_KEY=keep-me\n");
  });

  it("refuses missing arguments", () => {
    const result = spawnSync("sh", [script, template], { cwd: tmpdir(), encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("usage: sh generate-env.sh <template> <target>");
  });
});
