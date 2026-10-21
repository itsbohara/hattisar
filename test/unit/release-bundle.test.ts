import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/release-bundle.sh");

const bundleFiles = [
  "compose.yml",
  "env.example",
  "NOTICE",
  "volumes/db/roles.sql",
  "volumes/db/_supabase.sql",
  "volumes/db/pooler.sql",
  "volumes/pooler/pooler.exs",
];

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "hattisar-release-bundle-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function pack(version = "0.1.0"): string {
  return execFileSync("sh", [script, version, outDir], { cwd: tmpdir(), encoding: "utf8" }).trim();
}

function entries(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry !== "" && !entry.endsWith("/"));
}

function extract(tarball: string): string {
  const dir = join(outDir, "extracted");
  mkdirSync(dir);
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return join(dir, "hattisar");
}

describe("release-bundle.sh", () => {
  it("packs the compose file, env template, volumes and NOTICE under hattisar/", () => {
    const tarball = pack();

    expect(tarball).toBe(join(outDir, "hattisar-0.1.0.tar.gz"));
    expect(entries(tarball).sort()).toEqual(bundleFiles.map((file) => `hattisar/${file}`).sort());
  });

  it("pins the hattisar image to the release version", () => {
    const compose = readFileSync(join(extract(pack()), "compose.yml"), "utf8");

    expect(compose).toContain(`ghcr.io/itsbohara/hattisar:\${HATTISAR_VERSION:-0.1.0}`);
    expect(compose).not.toContain(":-latest}");
    expect(compose).not.toContain("build:");
  });

  it("copies the env template and volume files unchanged", () => {
    const bundle = extract(pack());

    for (const file of bundleFiles.filter((file) => file !== "compose.yml")) {
      expect(readFileSync(join(bundle, file))).toEqual(readFileSync(join(root, "docker", file)));
    }
  });

  it("leaves out macOS metadata files", () => {
    expect(entries(pack()).filter((entry) => basename(entry).startsWith("._"))).toEqual([]);
  });

  it.each(["v0.1.0", "0.1", "latest"])("refuses version %s", (version) => {
    const result = spawnSync("sh", [script, version, outDir], { cwd: tmpdir(), encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(
      `release-bundle: version must look like 1.2.3, got ${version}`,
    );
    expect(readdirSync(outDir)).toEqual([]);
  });
});
