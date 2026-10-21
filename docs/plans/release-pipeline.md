# Server Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `v<version>` tag publishes the hattisar server image to GHCR (amd64 + arm64) and a GitHub release whose bundle runs with `docker compose up -d`, no checkout or build.

**Architecture:** `docker/compose.yml` stops building and names a published image whose tag defaults to `latest`; building moves to overrides (`compose.dev.yml`, new `compose.source.yml`). `scripts/release-bundle.sh` packs the compose file (tag pinned to the release version), env template and volume files into a tarball. `.github/workflows/release.yml` builds and pushes the image, then attaches the bundle to a GitHub release.

**Tech Stack:** Docker Compose v2, GitHub Actions (docker/* actions), POSIX sh, vitest.

**Spec:** `docs/design.md` §16 (server releases) and §14 (roadmap). Issue #18.

## Global Constraints

- Image: `ghcr.io/itsbohara/hattisar`; tags `<version>`, `<major>.<minor>`, `latest`; platforms `linux/amd64,linux/arm64`; Dockerfile stage `runtime`.
- Release tag `v<version>`, version equal to `package.json` `version`; tag commit must be an ancestor of `origin/main`. CLI tags (`cli-v*`) are untouched and must not trigger this workflow.
- `package.json` version becomes `0.1.0` in this change; the user pushes the `v0.1.0` tag after merge.
- `docker/compose.yml` hattisar image line, verbatim: `image: ghcr.io/itsbohara/hattisar:${HATTISAR_VERSION:-latest}`; no `build:` key in that file.
- Bundle: `hattisar-<version>.tar.gz`, unpacking to `hattisar/` with exactly `compose.yml`, `env.example`, `NOTICE`, `volumes/db/{roles.sql,_supabase.sql,pooler.sql}`, `volumes/pooler/pooler.exs`; its compose image line reads `${HATTISAR_VERSION:-<version>}`.
- `pnpm stack:up` / `stack:down` and CI's `stack` job keep working unchanged (they already pass `-f docker/compose.dev.yml`).
- Repo rules: commits split by layer, no co-author footer, comments only for traps / non-local reasons, Biome-clean.

## Review Focus

1. A prerelease tag (`v0.2.0-rc.1`) must not move `latest` or `0.2`, and its GitHub release is marked prerelease. → Task 3 workflow conditions.
2. A tag not on `main`, or not matching `package.json`, must fail before anything is pushed. → Task 3 first step, before login/build.
3. The arm64 image must actually run (better-sqlite3 is native). → Task 3 smoke step runs both platforms under QEMU before the release is created.
4. Someone who ran production from a checkout (`compose.yml up --build`) now gets a pull instead of a build; README must point them at `compose.source.yml`. → Task 1.
5. A bundle built on macOS must not carry `._*` AppleDouble files; a bundle script run from any cwd must find the repo. → Task 2 tests.

---

### Task 1: Compose names the published image; building moves to overrides

**Files:**
- Modify: `docker/compose.yml` (hattisar service: replace `build:` block with the image line)
- Modify: `docker/compose.dev.yml` (hattisar `build:` gets `context: ..` and `dockerfile: docker/Dockerfile` alongside `target: dev`)
- Create: `docker/compose.source.yml` (only `services.hattisar.build` with `context: ..`, `dockerfile: docker/Dockerfile`, `target: runtime`; one comment line saying it builds a checkout instead of pulling the release image)
- Modify: `README.md` "Production" and "Managed boxes" sections

**Interfaces:**
- Produces: the literal `${HATTISAR_VERSION:-latest}` appears exactly once in `docker/compose.yml` (Task 2 substitutes it).

- [ ] **Step 1: Verify current state** — `docker compose --env-file docker/env.example -f docker/compose.yml config --images` lists `hattisar-hattisar` (built image).
- [ ] **Step 2: Edit the three compose files.**
- [ ] **Step 3: Verify** each, all must succeed:
  - `docker compose --env-file docker/env.example -f docker/compose.yml config --images | grep -x 'ghcr.io/itsbohara/hattisar:latest'`
  - `HATTISAR_VERSION=9.9.9 docker compose --env-file docker/env.example -f docker/compose.yml config --images | grep -x 'ghcr.io/itsbohara/hattisar:9.9.9'`
  - `docker compose --env-file docker/env.example -f docker/compose.yml -f docker/compose.dev.yml config | grep -A4 'build:'` shows `target: dev` and the Dockerfile path.
  - Same with `compose.source.yml` shows `target: runtime`.
  - `grep -c 'build:' docker/compose.yml` prints `0`.
- [ ] **Step 4: README.** "Production" gives two ways: from a release (download the bundle from the GitHub release, `cp env.example .env`, fill secrets per the comments in `env.example`, `docker compose up -d`; upgrade = new bundle's `compose.yml`, `docker compose pull && docker compose up -d`) and from a checkout (`docker compose -f docker/compose.yml -f docker/compose.source.yml up -d --build`). Update the managed-boxes command the same way. Keep the existing "Before exposing it" list.
- [ ] **Step 5: `pnpm lint`** passes; commit `chore(docker): name the published image and build from overrides` (compose files) and `docs: run a release or a checkout in production` (README).

### Task 2: Release bundle script

**Files:**
- Create: `scripts/release-bundle.sh`
- Test: `test/unit/release-bundle.test.ts`

**Interfaces:**
- Consumes: Task 1's single `${HATTISAR_VERSION:-latest}` in `docker/compose.yml`.
- Produces: `sh scripts/release-bundle.sh <version> <out-dir>` writes `<out-dir>/hattisar-<version>.tar.gz`, prints that path on stdout, exits 0. Version not matching `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` → stderr `release-bundle: version must look like 1.2.3, got <arg>`, exit 2. Missing args → usage on stderr, exit 2. Task 3 calls it with `"$VERSION" "$RUNNER_TEMP"`.

- [ ] **Step 1: Write the failing tests** in `test/unit/release-bundle.test.ts` (run the script with `execFileSync("sh", [script, ...])` from `os.tmpdir()` as cwd, into a fresh `mkdtemp` dir; list with `tar -tzf`, extract with `tar -xzf`):
  - `it("packs the compose file, env template, volumes and NOTICE under hattisar/")` — sorted file entries (directories excluded) equal exactly the Global Constraints list prefixed `hattisar/`; stdout is the tarball path.
  - `it("pins the hattisar image to the release version")` — extracted `compose.yml` contains `ghcr.io/itsbohara/hattisar:${HATTISAR_VERSION:-0.1.0}`, not `:-latest}`, and no `build:`.
  - `it("copies the env template and volume files unchanged")` — each extracted file's bytes equal its source under `docker/`.
  - `it("leaves out macOS metadata files")` — no entry's basename starts with `._`.
  - `it.each(["v0.1.0", "0.1", "latest"])("refuses version %s")` — exit status 2, stderr `release-bundle: version must look like 1.2.3, got <v>`, no tarball written.
- [ ] **Step 2: Run** `pnpm exec vitest run test/unit/release-bundle.test.ts` — FAIL (script missing).
- [ ] **Step 3: Implement** `scripts/release-bundle.sh`: `set -eu`; repo root from `$(dirname "$0")/..` like `scripts/dev-env.sh`; stage into a `mktemp -d` dir removed by `trap`; `sed` the image default; fail (exit 1, stderr) unless the pinned line is present exactly once after substitution; `COPYFILE_DISABLE=1 tar -czf … -C <stage> hattisar`.
- [ ] **Step 4: Run** the test file — PASS; `pnpm test` — all pass; `pnpm lint` clean.
- [ ] **Step 5: Commit** `feat(release): pack the compose bundle for a server release` (script) and `test: cover the release bundle` (test).

### Task 3: Release workflow and first version

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `package.json` (`"version": "0.1.0"`)
- Modify: `README.md` (short "Releases" note near the CLI release note: tag `v<version>` matching `package.json` on main publishes the image and bundle)

**Interfaces:**
- Consumes: `scripts/release-bundle.sh <version> <out-dir>` (Task 2); Dockerfile stage `runtime`.

- [ ] **Step 1: Write `release.yml`**, modelled on `.github/workflows/release-cli.yml` (read it first):
  - `on: push: tags: ["v*"]`; top-level `permissions: contents: read`; job permissions `contents: write`, `packages: write`.
  - Checkout with `fetch-depth: 0`; the same "tag is on main and matches `package.json`" step as the CLI workflow (with `./package.json`), exporting `VERSION`; plus `PRERELEASE=true` when `VERSION` contains `-`. This step runs before any login or build.
  - pnpm + Node 24, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
  - `docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, `docker/login-action@v3` (registry `ghcr.io`, user `${{ github.actor }}`, password `${{ secrets.GITHUB_TOKEN }}`).
  - `docker/metadata-action@v5` with image `ghcr.io/itsbohara/hattisar` and tags `type=semver,pattern={{version}}`, `type=semver,pattern={{major}}.{{minor}}`, `type=raw,value=latest,enable=${{ !contains(github.ref_name, '-') }}` (semver already skips `{{major}}.{{minor}}` for prereleases); label `org.opencontainers.image.source` comes from the action.
  - `docker/build-push-action@v6`: context `.`, file `docker/Dockerfile`, target `runtime`, platforms `linux/amd64,linux/arm64`, push, tags/labels from metadata, `cache-from/to: type=gha` (`mode=max`).
  - Smoke step, for each of `linux/amd64` and `linux/arm64`: `docker run --rm --platform <p> ghcr.io/itsbohara/hattisar:$VERSION node -e "new (require('better-sqlite3'))(':memory:'); require('pg'); console.log('ok')"` must print `ok`. One comment line: the image is already pushed, so a failure here stops the release, not the push.
  - Bundle: `sh scripts/release-bundle.sh "$VERSION" "$RUNNER_TEMP"`; `gh release create "$GITHUB_REF_NAME" "$RUNNER_TEMP/hattisar-$VERSION.tar.gz" --title "hattisar $VERSION" --generate-notes`, plus `--prerelease` when `PRERELEASE=true`; `GH_TOKEN: ${{ github.token }}`.
- [ ] **Step 2: Verify** `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color` reports nothing for both workflow files; `grep '"version"' package.json` shows `0.1.0`.
- [ ] **Step 3: Verify the image builds for arm64 locally** (slow, QEMU): `docker buildx build --platform linux/arm64 -f docker/Dockerfile --target runtime -t hattisar:arm64-check --load .` then the smoke `docker run --rm --platform linux/arm64 hattisar:arm64-check node -e "new (require('better-sqlite3'))(':memory:'); console.log('ok')"` prints `ok`. Remove the image afterwards.
- [ ] **Step 4: Commit** `ci: publish the server image and bundle on v* tags` (workflow), `chore: version the server 0.1.0` (package.json), `docs: describe server releases` (README).
