# Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `curl -fsSL https://github.com/itsbohara/hattisar/releases/latest/download/install.sh | sudo sh` installs hattisar into `/opt/hattisar` with fresh secrets, an optional Caddy-served domain and optional managed boxes, and re-running it upgrades.

**Architecture:** `scripts/install.sh` downloads the release bundle (§16), drives `generate-env.sh` and `docker compose`, and persists its answers in `.env`. `generate-env.sh` learns to fill keys missing from an existing `.env`, which upgrades need. `docker/compose.yml` gains a bind address and a `caddy` profile; the release workflow attaches `install.sh`.

**Tech Stack:** POSIX sh, Docker Compose v2, Caddy 2, GitHub Actions, vitest.

**Spec:** `docs/design.md` §17 (installer) and §16 (releases). Issue #19.

## Global Constraints

- Default dir `/opt/hattisar`; Linux `x86_64`/`aarch64` only; `docker compose version` must succeed. Refusals happen before anything is written.
- Options exactly: `--dir <path>`, `--version <x.y.z>`, `--domain <name>`, `--no-domain`, `--managed-boxes`, `--no-managed-boxes`, `--yes`. Unknown option or bad value → stderr `install: <message>`, exit 2.
- Prompts read from `/dev/tty`. Copy: `Domain for hattisar (empty: localhost only): ` and `Enable managed boxes? hattisar reaches Docker through a socket proxy to run Postgres containers. [Y/n] `.
- `.env` keys the installer sets: `HATTISAR_BIND=127.0.0.1` always; with a domain `HATTISAR_DOMAIN=<d>`, `HATTISAR_PUBLIC_HOST=<d>`, `HATTISAR_COOKIE_SECURE=true`; `HATTISAR_MANAGED_BOXES=true|false`; `COMPOSE_PROFILES` = comma-joined subset of `caddy,managed-boxes` in that order (empty when neither).
- Registry backup: `/data/hattisar.db.bak-<old version>` in the `hattisar` service's volume, taken with hattisar stopped, skipped when `/data/hattisar.db` does not exist.
- Release base URL `https://github.com/itsbohara/hattisar/releases`, overridable by env `HATTISAR_RELEASES_URL` (tests use `file://`). Bundle URL `<base>/download/v<version>/hattisar-<version>.tar.gz`.
- Never print secrets other than the admin password on first install; never put secrets in argv.
- Pinned images: `caddy` pinned to an exact `2.x.y` tag that exists on Docker Hub.
- Repo rules: commits split by layer, no co-author footer, comments only for traps / non-local reasons, Biome-clean.

## Review Focus

1. `curl | sh` where the download is cut mid-file must execute nothing. → Task 3: everything inside `main`, called on the last line; a test runs a truncated copy and asserts no docker call.
2. Run under `curl | sh` the script's stdin is the pipe: a prompt must read `/dev/tty`, and with no terminal it must stop (exit 2, naming the flag), never hang or silently pick a default. → Task 3 test spawns detached (no controlling tty) without `--yes`.
3. An upgrade must never alter an existing `.env` line, even when `env.example` gained keys. → Task 1 test (fill missing) and Task 3 upgrade test (old lines byte-identical).
4. A failed download (bad version, offline) must leave an existing install untouched. → Task 3 test: upgrade to a version with no bundle exits 1, dir unchanged, no docker call.
5. Choosing a domain must not leave hattisar's own port public. → Task 2 `compose config` check with `HATTISAR_BIND=127.0.0.1` shows `host_ip: 127.0.0.1`; Task 3 asserts `HATTISAR_BIND=127.0.0.1` in both modes.

---

### Task 1: `generate-env.sh` fills keys missing from an existing target

**Files:**
- Modify: `scripts/generate-env.sh`, `scripts/dev-env.sh` (drop the S3 append block; generate-env now covers it)
- Test: `test/unit/generate-env.test.ts`

**Interfaces:**
- Produces: `sh generate-env.sh <template> <target>`. Target missing → unchanged behaviour. Target present → for each `KEY=` line in the template whose key the target lacks, append `KEY=<value>` (generated hex of the existing length for the nine secret keys, else the template's value) and print `added KEY to <target>`; existing lines never change; nothing printed when nothing is missing.

- [ ] **Step 1: Failing tests** in `generate-env.test.ts`:
  - `it("adds keys the template has and the target lacks")` — target = generated file with the `POOLER_JWT_SECRET` and `HATTISAR_PURGE_AFTER_DAYS` lines removed; run; both keys present, `POOLER_JWT_SECRET` 64 hex, `HATTISAR_PURGE_AFTER_DAYS=7`; stdout has `added POOLER_JWT_SECRET to <target>` and `added HATTISAR_PURGE_AFTER_DAYS to <target>`; every original line still present in order, unchanged.
  - Replace the existing "leaves an existing target untouched" test: a complete target stays byte-identical and stdout is empty.
- [ ] **Step 2:** `pnpm exec vitest run test/unit/generate-env.test.ts` — the new test FAILS.
- [ ] **Step 3: Implement.** One table of secret keys and hex lengths shared by both paths (no duplicated sed list). Keys compared by the text before the first `=`; commented lines ignored. Appending keeps `umask 077` and does not rewrite the file.
- [ ] **Step 4:** focused test PASSES; in a scratch copy (`cp -R scripts docker/env.example` into `$TMPDIR`), `dev-env.sh` on a target lacking `S3_TEST_*` adds them; `pnpm test`, `pnpm lint` clean.
- [ ] **Step 5: Commit** `feat(release): fill keys a release adds to an existing env` (scripts) and `test: cover filling missing env keys` (test).

### Task 2: Bind address and the `caddy` profile

**Files:**
- Modify: `docker/compose.yml` (hattisar `ports` → `${HATTISAR_BIND:-0.0.0.0}:${HATTISAR_PORT:-8000}:8000`; new `caddy` service; volumes `caddy-data`, `caddy-config`)
- Create: `docker/volumes/caddy/Caddyfile`
- Modify: `docker/env.example` (`HATTISAR_BIND=0.0.0.0`, `HATTISAR_DOMAIN=` with one comment line each saying the installer sets them), `scripts/release-bundle.sh` + `test/unit/release-bundle.test.ts` (bundle gains `volumes/caddy/Caddyfile`), README Configuration table rows for both, `docs/design.md` §16 bundle list.

**Interfaces:**
- Produces: compose service `caddy`, `profiles: [caddy]`, `restart: unless-stopped`, `depends_on: hattisar` (service_healthy), ports `80:80`, `443:443`, `443:443/udp`, env `HATTISAR_DOMAIN: ${HATTISAR_DOMAIN:-}`, volumes `./volumes/caddy/Caddyfile:/etc/caddy/Caddyfile:ro,z`, `caddy-data:/data`, `caddy-config:/config`. Caddyfile: `{$HATTISAR_DOMAIN} {` / `reverse_proxy hattisar:8000` / `}`.

- [ ] **Step 1: Failing test:** release-bundle file list includes `hattisar/volumes/caddy/Caddyfile` and its bytes match the source. Run → FAIL.
- [ ] **Step 2: Implement** the compose, Caddyfile, env.example, bundle script changes. Pick the newest stable `caddy:2.x.y` tag (check Docker Hub) and pin it.
- [ ] **Step 3: Verify:**
  - `HATTISAR_BIND=127.0.0.1 docker compose --env-file docker/env.example -f docker/compose.yml config --format json | jq '.services.hattisar.ports'` shows `host_ip` `127.0.0.1`; without it, no `host_ip` restriction (or `0.0.0.0`).
  - `COMPOSE_PROFILES=caddy HATTISAR_DOMAIN=example.com docker compose --env-file docker/env.example -f docker/compose.yml config --services` lists `caddy`; without the profile it does not.
  - `docker run --rm -e HATTISAR_DOMAIN=example.com -v "$PWD/docker/volumes/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" <pinned caddy> caddy validate --config /etc/caddy/Caddyfile` passes.
  - Release-bundle tests PASS; `pnpm test`, `pnpm lint` clean.
- [ ] **Step 4: Commit** `feat(docker): bind hattisar's port and serve a domain through caddy` (compose, Caddyfile, env.example), `feat(release): ship the Caddyfile in the bundle` (script), `test: cover the Caddyfile in the bundle`, `docs: document the bind address and domain` (README, design).

### Task 3: `scripts/install.sh`

**Files:**
- Create: `scripts/install.sh`
- Test: `test/unit/install.test.ts`

**Interfaces:**
- Consumes: Task 1 `generate-env.sh` fill behaviour; Task 2 `.env` keys and the `caddy` profile; §16 bundle layout and the pinned `${HATTISAR_VERSION:-<version>}` line (old version is read from it).
- Produces: `install.sh` (attached to releases by Task 4). Exit 0 success, 1 runtime failure (download, docker), 2 usage / missing answer with no terminal.

- [ ] **Step 1: Test harness.** Each test: `mkdtemp`; a `bin/` with stub `docker` (appends `"$*"` plus `cwd=$PWD` to `docker.log`, exits 0; `compose version` prints a version) and stub `uname` (`-s` → `$STUB_OS` default `Linux`, `-m` → `$STUB_ARCH` default `x86_64`); a releases dir built with `sh scripts/release-bundle.sh <v> <releases>/download/v<v>` for `0.1.0` and `0.2.0`; run `sh scripts/install.sh …` with `PATH=bin:$PATH`, `HATTISAR_RELEASES_URL=file://<releases>`, via `spawnSync` with `detached: true` so there is no controlling terminal.
- [ ] **Step 2: Failing tests:**
  - `it("installs with defaults under --yes")` — `--yes --version 0.1.0 --dir <d>`: exit 0; `<d>/compose.yml` pins `0.1.0`; `.env` has no `dev-only-`, `HATTISAR_BIND=127.0.0.1`, `HATTISAR_MANAGED_BOXES=true`, `COMPOSE_PROFILES=managed-boxes`; docker log has `compose pull` then `compose up -d --wait`, both `cwd=<d>`; stdout contains `http://localhost:8000`, `admin` and the `.env`'s `HATTISAR_ADMIN_PASSWORD`.
  - `it("serves a domain through caddy")` — `--domain hattisar.example.com --no-managed-boxes --version 0.1.0 --dir <d>`: `.env` has `HATTISAR_DOMAIN=hattisar.example.com`, `HATTISAR_PUBLIC_HOST=hattisar.example.com`, `HATTISAR_COOKIE_SECURE=true`, `HATTISAR_BIND=127.0.0.1`, `HATTISAR_MANAGED_BOXES=false`, `COMPOSE_PROFILES=caddy`; stdout contains `https://hattisar.example.com`.
  - `it("upgrades without touching .env")` — install 0.1.0 with `--yes`, change `.env`'s `HATTISAR_PURGE_AFTER_DAYS` to `30` by hand, clear the log, run `--version 0.2.0 --dir <d>` (no answers flags, no tty): exit 0, no prompt needed; `.env` byte-identical; `compose.yml` pins `0.2.0`; log order: `compose pull`, `compose stop hattisar`, a `compose run --rm --no-deps` whose args contain `hattisar.db.bak-0.1.0`, `compose up -d --wait`; stdout has no `HATTISAR_ADMIN_PASSWORD` value.
  - `it("leaves an install alone when the download fails")` — install 0.1.0, snapshot dir, clear log, run `--version 9.9.9`: exit 1, stderr names the URL, dir snapshot equal, log empty.
  - `it("stops without a terminal when a question is unanswered")` — `--version 0.1.0 --dir <d>` alone: exit 2, stderr mentions `--domain` or `--no-domain`; `<d>` not created; log empty.
  - `it.each([["Darwin","x86_64"],["Linux","armv7l"]])("refuses %s %s")` — exit 1, stderr names the OS/arch, `<d>` not created.
  - `it.each(["--version v0.1.0","--bogus","--domain"])("rejects %s")` — exit 2.
  - `it("runs nothing when the script is cut short")` — run the first half of `install.sh`'s bytes (cut at a line boundary): log empty, `<d>` not created.
- [ ] **Step 3:** run → FAIL (script missing).
- [ ] **Step 4: Implement** per §17. Notes the tests don't pin: latest version = last path segment of `curl -fsSLI -o /dev/null -w '%{url_effective}' <base>/latest` with a leading `v` stripped, validated with the §16 version regex; downloads to a `mktemp -d` removed by `trap`, unpacked and only then copied over the dir (so a failed download changes nothing); `.env` keys set by a `set_env KEY VALUE` that rewrites the one line via a temp file in the same dir (keep mode 600) or appends; the `cp` for the backup runs as `docker compose run --rm --no-deps --entrypoint sh hattisar -c '…'` with the paths fixed in the script, not user input. Domain accepted when it matches `^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$`; otherwise exit 2 (flag) or re-ask (prompt). Directory not creatable → exit 1 with `run with sudo or pass --dir`.
- [ ] **Step 5:** tests PASS; `pnpm test`, `pnpm lint` clean; `shellcheck -s sh scripts/install.sh` (via `docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:v0.10.0 -s sh /mnt/scripts/install.sh`) clean.
- [ ] **Step 6: Commit** `feat(release): install and upgrade hattisar with one command` (script) and `test: cover the installer`.

### Task 4: Ship the installer and document it

**Files:**
- Modify: `.github/workflows/release.yml` (`gh release create` also attaches `scripts/install.sh` as `install.sh`)
- Modify: `README.md` (new "Install" subsection at the top of Production: the one-liner, `| sudo sh -s -- --domain hattisar.example.com --yes` example, upgrade = run it again, without a domain reach it via `ssh -L 8000:localhost:8000 <server>` or your own proxy to `127.0.0.1:8000`; the manual bundle path stays as "From a release by hand")

- [ ] **Step 1:** workflow edit; actionlint (`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color`) clean.
- [ ] **Step 2:** README edit; lines ≤100 chars.
- [ ] **Step 3: Verify end to end on Linux** (amd64 under Docker Desktop): in a `docker:27-dind` container with the repo mounted, build the 0.1.0-shaped bundle into a scratch releases dir, run `HATTISAR_RELEASES_URL=file://… sh scripts/install.sh --yes --version 0.1.0 --dir /opt/hattisar` against the real `ghcr.io/itsbohara/hattisar:0.1.0`, `curl -fsS http://127.0.0.1:8000/_hs/healthz` returns 200, then re-run with the same version: upgrade path completes and `/data/hattisar.db.bak-0.1.0` exists. Tear the container down. Do not touch the host's compose stack.
- [ ] **Step 4: Commit** `ci: attach the installer to server releases`, `docs: install hattisar with one command`.
