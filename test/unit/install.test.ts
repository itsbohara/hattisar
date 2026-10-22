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
  symlinkSync,
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
if [ -n "\${STUB_FAIL:-}" ]; then
  case "$*" in "$STUB_FAIL"*) exit 1 ;; esac
fi
case "$*" in
  "volume ls"*) printf '%s' "\${STUB_VOLUMES:-}" ;;
  "compose run"*)
    # Runs the backup script against STUB_DATA standing in for the volume's /data.
    [ -n "\${STUB_DATA:-}" ] || exit 0
    while [ $# -gt 1 ] && [ "$1" != -c ]; do shift; done
    printf '%s\n' "$2" | sed "s|/data|$STUB_DATA|g" | sh
    ;;
esac
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

function release(version: string, alter?: (bundle: string) => void) {
  const out = join(releases, "download", `v${version}`);
  mkdirSync(out, { recursive: true });
  const tarball = execFileSync("sh", [join(root, "scripts/release-bundle.sh"), version, out], {
    encoding: "utf8",
  }).trim();
  if (!alter) return;
  const unpacked = join(releases, `unpacked-${version}`);
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
  alter(join(unpacked, "hattisar"));
  execFileSync("tar", ["-czf", tarball, "-C", unpacked, "hattisar"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

beforeAll(() => {
  releases = mkdtempSync(join(tmpdir(), "hattisar-install-releases-"));
  release("0.1.0");
  release("0.2.0");
  // Bundles from before the installer: no HATTISAR_BIND in compose.yml, then no Caddyfile.
  release("0.0.8", (bundle) => {
    const compose = join(bundle, "compose.yml");
    writeFileSync(
      compose,
      readFileSync(compose, "utf8").replaceAll(`\${HATTISAR_BIND:-0.0.0.0}:`, ""),
    );
  });
  release("0.0.9", (bundle) => rmSync(join(bundle, "volumes/caddy"), { recursive: true }));
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

function mutatingCalls(): string[] {
  return dockerCalls().filter((call) => !call.startsWith("volume ls "));
}

// A PATH holding only the stubs and the named host tools, to run without one (openssl).
function onlyTools(tools: string[]): string {
  const bin = join(work, "only-bin");
  mkdirSync(bin);
  for (const tool of tools) {
    const path = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(path, join(bin, tool));
  }
  for (const stub of ["docker", "uname"]) symlinkSync(join(work, "bin", stub), join(bin, stub));
  return bin;
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
    const calls = mutatingCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^compose pull cwd=/);
    expect(calls[1]).toBe(`compose up -d --wait cwd=${dir}`);
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
    expect(result.stderr).toBe("");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(edited);
    expect(readFileSync(join(dir, "compose.yml"), "utf8")).toContain(
      `ghcr.io/itsbohara/hattisar:\${HATTISAR_VERSION:-0.2.0}`,
    );
    const calls = dockerCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatch(/^compose pull cwd=/);
    expect(calls[0]).not.toBe(`compose pull cwd=${dir}`);
    expect(calls[1]).toBe(`compose stop hattisar cwd=${dir}`);
    expect(calls[2]).toMatch(/^compose run -T --rm --no-deps /);
    for (const file of ["hattisar.db", "hattisar.db-wal", "hattisar.db-shm"]) {
      expect(calls[2]).toContain(file);
    }
    expect(calls[2]).toContain(".bak-0.1.0");
    expect(calls[2]).toContain(`cwd=${dir}`);
    expect(calls[3]).toBe(`compose up -d --wait cwd=${dir}`);
    expect(result.stdout).toContain("http://localhost:8000");
    expect(result.stdout).not.toContain(".bak-");
    expect(result.stdout).not.toContain(env().get("HATTISAR_ADMIN_PASSWORD"));
  });

  it("names the registry backup when one was taken", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const data = join(work, "data");
    mkdirSync(data);
    writeFileSync(join(data, "hattisar.db"), "registry");
    writeFileSync(join(data, "hattisar.db-wal"), "wal");

    const result = install(`--version 0.2.0 --dir ${dir}`, { STUB_DATA: data });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(data, "hattisar.db.bak-0.1.0"), "utf8")).toBe("registry");
    expect(readFileSync(join(data, "hattisar.db-wal.bak-0.1.0"), "utf8")).toBe("wal");
    expect(existsSync(join(data, "hattisar.db-shm.bak-0.1.0"))).toBe(false);
    expect(result.stdout).toContain("hattisar.db.bak-0.1.0");
    expect(result.stdout).toContain("hattisar.db-wal.bak-0.1.0");
  });

  it("keeps a backup an earlier attempt already took", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const data = join(work, "data");
    mkdirSync(data);
    writeFileSync(join(data, "hattisar.db"), "half-migrated");
    writeFileSync(join(data, "hattisar.db-wal"), "wal");
    writeFileSync(join(data, "hattisar.db.bak-0.1.0"), "clean");

    const result = install(`--version 0.2.0 --dir ${dir}`, { STUB_DATA: data });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(data, "hattisar.db.bak-0.1.0"), "utf8")).toBe("clean");
    expect(existsSync(join(data, "hattisar.db-wal.bak-0.1.0"))).toBe(false);
    expect(result.stdout).toMatch(/hattisar\.db\.bak-0\.1\.0.*kept/);
  });

  it("refuses a bundle from before the installer", () => {
    const result = install(`--yes --version 0.0.8 --dir ${dir}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "hattisar 0.0.8 predates the installer; pass --version <newer>",
    );
    expect(existsSync(dir)).toBe(false);
    expect(mutatingCalls()).toEqual([]);
  });

  it("refuses a domain with a bundle that has no Caddyfile", () => {
    const result = install(`--domain h.example.com --yes --version 0.0.9 --dir ${dir}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "hattisar 0.0.9 predates the installer; pass --version <newer>",
    );
    expect(existsSync(dir)).toBe(false);
    expect(mutatingCalls()).toEqual([]);
    expect(install(`--no-domain --yes --version 0.0.9 --dir ${dir}`).status).toBe(0);
  });

  it("explains where things stand when the first start fails", () => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`, { STUB_FAIL: "compose up" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${dir}/.env`);
    expect(result.stderr).toMatch(/re-run/i);
    expect(result.stderr).toContain("docker compose down -v");
    expect(result.stderr).not.toContain(env().get("HATTISAR_ADMIN_PASSWORD"));
    expect(result.stdout).not.toContain(env().get("HATTISAR_ADMIN_PASSWORD"));
  });

  it("explains how to roll back when the upgraded stack fails to start", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const data = join(work, "data");
    mkdirSync(data);
    writeFileSync(join(data, "hattisar.db"), "registry");

    const result = install(`--version 0.2.0 --dir ${dir}`, {
      STUB_DATA: data,
      STUB_FAIL: "compose up",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hattisar.db.bak-0.1.0");
    expect(result.stderr).toContain("HATTISAR_VERSION=0.1.0");
    expect(result.stderr).toMatch(/roll back/);
  });

  it.each([
    ["0.2.0", "0.1.0"],
    ["0.2.0", "0.2.0-rc.1"],
  ])("refuses to downgrade %s to %s", (installed, target) => {
    expect(install(`--yes --version ${installed} --dir ${dir}`).status).toBe(0);
    const before = snapshot(dir);
    writeFileSync(log, "");

    const result = install(`--version ${target} --dir ${dir}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(installed);
    expect(result.stderr).toContain(target);
    expect(result.stderr).toContain("backup");
    expect(snapshot(dir)).toEqual(before);
    expect(mutatingCalls()).toEqual([]);
  });

  it("re-runs the installed version", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);

    expect(install(`--version 0.1.0 --dir ${dir}`).status).toBe(0);
  });

  it("warns when .env pins HATTISAR_VERSION", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    writeFileSync(
      join(dir, ".env"),
      `${readFileSync(join(dir, ".env"), "utf8")}HATTISAR_VERSION=0.1.0\n`,
    );

    const result = install(`--version 0.2.0 --dir ${dir}`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/^install: .*HATTISAR_VERSION=0\.1\.0/m);
  });

  it("says when the Docker daemon cannot be reached", () => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`, { STUB_FAIL: "volume ls" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot reach the Docker daemon");
    expect(existsSync(dir)).toBe(false);
  });

  it("notes the answer flags an upgrade ignores", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const before = readFileSync(join(dir, ".env"), "utf8");

    const result = install(
      `--domain h.example.com --no-managed-boxes --version 0.2.0 --dir ${dir}`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("ignored");
    for (const key of [
      "HATTISAR_DOMAIN",
      "HATTISAR_PUBLIC_HOST",
      "HATTISAR_COOKIE_SECURE",
      "HATTISAR_MANAGED_BOXES",
      "COMPOSE_PROFILES",
      "docker compose up -d",
    ]) {
      expect(result.stderr).toContain(key);
    }
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  });

  it.each(["compose pull", "compose stop", "compose run"])(
    "leaves an install alone when %s fails mid-upgrade",
    (failing) => {
      expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
      const before = snapshot(dir);

      const result = install(`--version 0.2.0 --dir ${dir}`, { STUB_FAIL: failing });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^install: /m);
      expect(snapshot(dir)).toEqual(before);
    },
  );

  it("creates nothing when the first pull fails", () => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`, { STUB_FAIL: "compose pull" });

    expect(result.status).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a first install over existing hattisar volumes", () => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`, {
      STUB_VOLUMES: "hattisar_hattisar-data\nhattisar_db-data\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hattisar_hattisar-data");
    expect(result.stderr).toContain("docker compose down -v");
    const calls = dockerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^volume ls -q --filter label=com\.docker\.compose\.project=hattisar /,
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses without openssl", () => {
    const result = install(`--yes --version 0.1.0 --dir ${dir}`, {
      PATH: onlyTools(["sh", "grep", "curl"]),
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("install: openssl is required");
    expect(existsSync(dir)).toBe(false);
    expect(mutatingCalls()).toEqual([]);
  });

  it("leaves an install alone when the download fails", () => {
    expect(install(`--yes --version 0.1.0 --dir ${dir}`).status).toBe(0);
    const before = snapshot(dir);
    writeFileSync(log, "");

    const result = install(`--version 9.9.9 --dir ${dir}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`file://${releases}/download/v9.9.9/hattisar-9.9.9.tar.gz`);
    expect(snapshot(dir)).toEqual(before);
    expect(mutatingCalls()).toEqual([]);
  });

  it("stops without a terminal when a question is unanswered", () => {
    const result = install(`--version 0.1.0 --dir ${dir}`);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--domain|--no-domain/);
    expect(existsSync(dir)).toBe(false);
    expect(mutatingCalls()).toEqual([]);
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
    expect(mutatingCalls()).toEqual([]);
  });

  it.each(["--version v0.1.0", "--bogus", "--domain", "--domain not_a.domain", "--dir"])(
    "rejects %s",
    (args) => {
      const result = install(`--yes ${args}`);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^install: /);
      expect(mutatingCalls()).toEqual([]);
    },
  );

  it("runs nothing when the script is cut short", () => {
    const bytes = readFileSync(script);
    const cut = bytes.lastIndexOf(0x0a, Math.floor(bytes.length / 2)) + 1;
    const half = join(work, "install-half.sh");
    writeFileSync(half, bytes.subarray(0, cut));

    install(`--yes --version 0.1.0 --dir ${dir}`, {}, half);

    expect(mutatingCalls()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});
