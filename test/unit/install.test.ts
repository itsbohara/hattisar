import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/install.sh");

const stubDocker = `#!/bin/sh
if [ "$1 $2" = "compose version" ]; then
  echo "Docker Compose version v2.29.0"
  exit 0
fi
echo "$* cwd=$PWD" >>"$DOCKER_LOG"
`;

const stubUname = `#!/bin/sh
case $1 in
  -s) echo "\${STUB_OS:-Linux}" ;;
  -m) echo "\${STUB_ARCH:-x86_64}" ;;
  *) exit 1 ;;
esac
`;

let releases: string;
let work: string;
let dir: string;
let log: string;

beforeAll(() => {
  releases = mkdtempSync(join(tmpdir(), "hattisar-install-releases-"));
  for (const version of ["0.1.0", "0.2.0"]) {
    const out = join(releases, "download", `v${version}`);
    mkdirSync(out, { recursive: true });
    execFileSync("sh", [join(root, "scripts/release-bundle.sh"), version, out]);
  }
});

afterAll(() => {
  rmSync(releases, { recursive: true, force: true });
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "hattisar-install-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ docker: stubDocker, uname: stubUname })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  dir = join(work, "hattisar");
  log = join(work, "docker.log");
  writeFileSync(log, "");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function install(args: string, env: Record<string, string> = {}, file = script) {
  // detached gives the script no controlling terminal, so /dev/tty cannot be opened. spawnSync
  // honours it, but its type leaves it out, hence the variable rather than an inline literal.
  const options = {
    cwd: work,
    encoding: "utf8" as const,
    detached: true,
    env: {
      ...process.env,
      PATH: `${join(work, "bin")}:${process.env.PATH}`,
      HATTISAR_RELEASES_URL: `file://${releases}`,
      DOCKER_LOG: log,
      ...env,
    },
  };
  return spawnSync("sh", [file, ...args.split(" ").filter(Boolean)], options);
}

function dockerCalls(): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

function env(): Map<string, string> {
  const pairs = readFileSync(join(dir, ".env"), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  return new Map(pairs as [string, string][]);
}

function snapshot(path: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(path, { recursive: true, encoding: "utf8" })) {
    const full = join(path, entry);
    if (statSync(full).isFile()) files[entry] = readFileSync(full, "utf8");
  }
  return files;
}

describe("install.sh", () => {
  it("installs with defaults under --yes", () => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "compose.yml"), "utf8")).toContain(
      `ghcr.io/itsbohara/hattisar:\${HATTISAR_VERSION:-0.1.0}`,
    );
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("dev-only-");
    const values = env();
    expect(values.get("HATTISAR_BIND")).toBe("127.0.0.1");
    expect(values.get("HATTISAR_MANAGED_BOXES")).toBe("true");
    expect(values.get("COMPOSE_PROFILES")).toBe("managed-boxes");
    expect(values.get("HATTISAR_DOMAIN")).toBe("");
    expect(dockerCalls()).toEqual([`compose pull cwd=${dir}`, `compose up -d --wait cwd=${dir}`]);
    expect(result.stdout).toContain("http://localhost:8000");
    expect(result.stdout).toContain("admin");
    expect(result.stdout).toContain(values.get("HATTISAR_ADMIN_PASSWORD"));
  });

  it("serves a domain through caddy", () => {
    const result = install(
      `--domain hattisar.example.com --no-managed-boxes --version 0.1.0 --dir ${dir}`,
    );

    expect(result.status, result.stderr).toBe(0);
    const values = env();
    expect(values.get("HATTISAR_DOMAIN")).toBe("hattisar.example.com");
    expect(values.get("HATTISAR_PUBLIC_HOST")).toBe("hattisar.example.com");
    expect(values.get("HATTISAR_COOKIE_SECURE")).toBe("true");
    expect(values.get("HATTISAR_BIND")).toBe("127.0.0.1");
    expect(values.get("HATTISAR_MANAGED_BOXES")).toBe("false");
    expect(values.get("COMPOSE_PROFILES")).toBe("caddy");
    expect(result.stdout).toContain("https://hattisar.example.com");
  });

  it("upgrades without touching .env", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const edited = readFileSync(join(dir, ".env"), "utf8").replace(
      /^HATTISAR_PURGE_AFTER_DAYS=.*$/m,
      "HATTISAR_PURGE_AFTER_DAYS=30",
    );
    writeFileSync(join(dir, ".env"), edited);
    writeFileSync(log, "");

    const result = install(`--version 0.2.0 --dir ${dir}`);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(edited);
    expect(readFileSync(join(dir, "compose.yml"), "utf8")).toContain(
      `ghcr.io/itsbohara/hattisar:\${HATTISAR_VERSION:-0.2.0}`,
    );
    const calls = dockerCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]).toBe(`compose pull cwd=${dir}`);
    expect(calls[1]).toBe(`compose stop hattisar cwd=${dir}`);
    expect(calls[2]).toMatch(/^compose run --rm --no-deps /);
    expect(calls[2]).toContain("hattisar.db.bak-0.1.0");
    expect(calls[2]).toContain(`cwd=${dir}`);
    expect(calls[3]).toBe(`compose up -d --wait cwd=${dir}`);
    expect(result.stdout).toContain("http://localhost:8000");
    expect(result.stdout).not.toContain(env().get("HATTISAR_ADMIN_PASSWORD"));
  });

  it("leaves an install alone when the download fails", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const before = snapshot(dir);
    writeFileSync(log, "");

    const result = install(`--version 9.9.9 --dir ${dir}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`file://${releases}/download/v9.9.9/hattisar-9.9.9.tar.gz`);
    expect(snapshot(dir)).toEqual(before);
    expect(dockerCalls()).toEqual([]);
  });

  it("stops without a terminal when a question is unanswered", () => {
    const result = install(`--version 0.1.0 --dir ${dir}`);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--domain|--no-domain/);
    expect(existsSync(dir)).toBe(false);
    expect(dockerCalls()).toEqual([]);
  });

  it("asks about managed boxes once the domain is answered", () => {
    const result = install(`--no-domain --version 0.1.0 --dir ${dir}`);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--managed-boxes|--no-managed-boxes/);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ["Darwin", "x86_64"],
    ["Linux", "armv7l"],
  ])("refuses %s %s", (os, arch) => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`, { STUB_OS: os, STUB_ARCH: arch });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(os === "Linux" ? arch : os);
    expect(existsSync(dir)).toBe(false);
    expect(dockerCalls()).toEqual([]);
  });

  it.each(["--version v0.1.0", "--bogus", "--domain", "--domain not_a.domain", "--dir"])(
    "rejects %s",
    (args) => {
      const result = install(`--yes ${args}`);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^install: /);
      expect(dockerCalls()).toEqual([]);
    },
  );

  it("runs nothing when the script is cut short", () => {
    const bytes = readFileSync(script);
    const cut = bytes.lastIndexOf(0x0a, Math.floor(bytes.length / 2)) + 1;
    const half = join(work, "install-half.sh");
    writeFileSync(half, bytes.subarray(0, cut));

    install(`--yes --version 0.1.0 --dir ${dir}`, {}, half);

    expect(dockerCalls()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});
