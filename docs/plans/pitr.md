# Box-level PITR with WAL-G (issue #22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested recipe for continuous WAL archiving and point-in-time restore of a whole box with WAL-G, for managed boxes and the shared box, proven by a throwaway-Docker script that a separate CI workflow runs.

**Architecture:** WAL-G v3.0.9 is built from source into a static musl binary (the pinned `supabase/postgres` image has no WAL-G and is Alpine). Archive settings go in with `ALTER SYSTEM`. The shared box gets the binary and a WAL-G env file from a compose override. A managed box gets them with `docker cp`. Base backups come from a host cron job running `docker exec`. Nothing under `src/` changes.

**Tech Stack:** POSIX sh, Docker / compose, WAL-G 3.0.9, Go 1.25 (inside the build image only), RustFS (S3-compatible, already pinned for dev/CI), GitHub Actions.

**Spec:** `.superpowers/pitr-research.md` (research with file:line and upstream references), plus the maintainer's approved decisions D1–D11 at its end, all accepted as recommended. `docs/design.md` §8 gets the shipped summary in Task 4.

## Global Constraints

- WAL-G version `v3.0.9`, built with `-tags libsodium`, no brotli, `CGO_ENABLED=1`, static (`-extldflags "-static"`), from `golang:1.25-alpine3.23`.
- Postgres image stays `supabase/postgres:17.6.1.136`. Never override `image:` for the shared box and never retag the pinned image.
- Archive settings: `archive_mode = on`, `archive_command = '/usr/local/bin/wal-g … wal-push %p'`, `archive_timeout = '60s'`, all through `ALTER SYSTEM`.
- Restore must set `recovery_target_action = 'promote'`. The image's `wal-g.conf` sets `hot_standby = off`, which turns `pause` into `shutdown`.
- Never start a box on an emptied data dir: the entrypoint would initdb a new cluster.
- WAL-G config keys: `WALG_S3_PREFIX`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT` (S3-compatible only), `AWS_S3_FORCE_PATH_STYLE`, `WALG_COMPRESSION_METHOD=zstd`, `WALG_LIBSODIUM_KEY` (`openssl rand -hex 32`), `WALG_LIBSODIUM_KEY_TRANSFORM=hex`, `PGHOST=/var/run/postgresql`, `PGUSER=supabase_admin`, `PGDATABASE=postgres`, `PGDATA=/var/lib/postgresql/data`.
- S3 layout: same bucket as hattisar, prefix `pitr/<box name>-<YYYYMMDD of enabling>/`, never under hattisar's own prefix, a new prefix per cluster and per PG major.
- Base backups: daily `docker exec -u postgres <container> wal-g [--config …] backup-push /var/lib/postgresql/data`, then `wal-g … delete retain FULL 7 --confirm`.
- Tests run only in Docker objects of compose project `hattisar-pitr-test` (or containers and volumes named `hattisar-pitr-test-*`), torn down on exit. Never touch the `hattisar` compose project, its containers or its volumes. Never read or print `docker/.env`.
- Shell scripts: POSIX `sh`, `set -eu`, shellcheck clean, matching `scripts/*.sh` style. Secrets never in argv or logs; the test generates throwaway keys.
- Docs prose matches `README.md` and `docs/design.md`: short sentences, plain words. Say plainly that PITR restores a whole box, not one project.

## Review Focus

- A secret (S3 key, libsodium key) ending up in argv, `docker inspect` env of a long-lived container, or script output. Keys go in files with mode 600 inside containers; the test never echoes them.
- The script leaking or touching non-test Docker objects when a step fails midway: the EXIT trap must remove everything named for the test, and only that.
- Archiving silently failing (binary missing after a container recreation) while the docs claim protection: a missing binary exits 127, which kills the archiver before `failed_count` moves, so the docs' check combines the `.ready` backlog (`pg_ls_archive_statusdir()`), `failed_count`/`last_failed_time` and the age of `last_archived_time`.
- The restore landing on the wrong point: the assertion must prove rows from before T are present and rows after T are absent, and that the server is out of recovery (`pg_is_in_recovery() = false`).
- arm64 hosts: the Dockerfile must build for the host architecture with no amd64 assumption.

---

### Task 1: WAL-G build, shared-box override, proof that it runs

**Files:**
- Create: `docker/wal-g/Dockerfile`
- Create: `docker/compose.walg.yml`
- Create: `scripts/pitr-test.sh` (steps 0–1 of the test; later tasks extend it)
- Modify: `scripts/release-bundle.sh` and `test/unit/release-bundle.test.ts`: ship `wal-g/Dockerfile` and `compose.walg.yml` in the bundle
- Modify: `.gitignore`: ignore `docker/walg/` (build output) and `docker/walg.env`

**Interfaces:**
- Produces: `docker build -f docker/wal-g/Dockerfile -o docker/walg docker/wal-g` writes `docker/walg/wal-g`. `docker/compose.walg.yml` adds to service `db` the volume `./walg/wal-g:/usr/local/bin/wal-g:ro` and `env_file: ./walg.env`. Relative paths resolve against `docker/` in a checkout and against the release dir in a bundle.
- Produces: `scripts/pitr-test.sh`, run from the repo root as `sh scripts/pitr-test.sh`. It defines functions later tasks reuse: `build_walg`, `cleanup` (EXIT trap), and a `log` helper.

- [ ] **Step 1:** Write `docker/wal-g/Dockerfile`: a multi-stage build from `golang:1.25-alpine3.23` (`build-base git libsodium-dev libsodium-static`), shallow clone of `https://github.com/wal-g/wal-g` at `v3.0.9`, `go build -tags libsodium ./main/pg` with static external linking, final stage `FROM scratch` holding `/wal-g`. The research sketch is at `.superpowers/pitr-research.md` §4.
- [ ] **Step 2:** In `scripts/pitr-test.sh`, step 0 asserts that `docker run --rm --entrypoint sh supabase/postgres:17.6.1.136 -c 'command -v wal-g'` fails. If it succeeds, the script fails with a message that the image now ships WAL-G and the recipe needs revisiting. Step 1 builds the binary and runs `wal-g --version` inside `supabase/postgres:17.6.1.136` (bind-mounted, `--entrypoint`) and asserts that the output contains `3.0.9`.
- [ ] **Step 3:** Run `sh scripts/pitr-test.sh`. Expected: exit 0, and the version line is printed. Also `shellcheck scripts/pitr-test.sh` is clean.
- [ ] **Step 4:** Write `docker/compose.walg.yml` as above, with a top comment giving the checkout usage (`-f docker/compose.yml -f docker/compose.walg.yml`) and the release usage (copy to `compose.override.yml`).
- [ ] **Step 5:** Bundle: `release-bundle.sh` copies `docker/wal-g/Dockerfile` to `wal-g/Dockerfile` and `docker/compose.walg.yml` to `compose.walg.yml`. Extend `test/unit/release-bundle.test.ts` to assert that both are in the tarball. Run `pnpm test -- release-bundle`, expected PASS.

### Task 2: Shared-box archive and restore in the test

**Files:**
- Modify: `scripts/pitr-test.sh`

**Interfaces:**
- Consumes: `build_walg`, `cleanup`, `log` (Task 1); `docker/compose.walg.yml`.
- Produces: functions `pitr_shared` and reusable helpers `psql_in <container> <sql>` (via `docker exec -u postgres … psql -U supabase_admin -tAc`), `wait_archived <container>` (polls `pg_stat_archiver` until the current WAL segment, after `pg_switch_wal()`, is archived; 60 s timeout) and `restore_to <container-or-helper args> <backup> <target time>`.

- [ ] **Step 1:** Bring up the S3 side under project `hattisar-pitr-test`. Use `docker/compose.dev.yml`'s `s3` and `s3-bucket` services (profile `s3-test`) together with `docker/compose.yml` and `docker/compose.walg.yml`, starting only `db`, `s3` and `s3-bucket`. Pass a throwaway env file generated into a temp dir (`--env-file`), never `docker/.env`. Write the throwaway `walg.env` (mode 600) with `WALG_S3_PREFIX=s3://<bucket>/pitr/test-<date>`, `AWS_ENDPOINT=http://s3:9000`, path style, region `us-east-1`, zstd and a generated libsodium key. The override's `./walg.env` resolves to `docker/walg.env`, which is git-ignored. Write it there and delete it in `cleanup`, or, if that path would clash with a real one, fail rather than overwrite.
- [ ] **Step 2:** Enable archiving with `ALTER SYSTEM` (the three settings), restart `db`, wait for it to be healthy. Then: `create table pitr_t(v int)`, insert 1, `backup-push`, insert 2, `pg_switch_wal()`, record `T` from `select now()`, sleep 2, insert 3, switch WAL, `wait_archived`. Assert that `backup-list` shows one backup and that `wal-g wal-verify integrity` reports OK.
- [ ] **Step 3:** Restore per research §5, steps 3–8: stop `db`, keep a safety copy, empty the data dir with a `--rm` helper (`docker compose run --rm --no-deps -u postgres --entrypoint sh db`), run `backup-fetch … LATEST`, append `restore_command`, `recovery_target_time = 'T'` and `recovery_target_action = 'promote'` to `postgresql.auto.conf`, `touch recovery.signal`, start. Assert: `select string_agg(v::text, ',' order by v) from pitr_t` is `1,2`; `pg_is_in_recovery()` is `f`; `recovery.signal` is gone; the timeline (`pg_control_checkpoint()`) is 2.
- [ ] **Step 4:** Assert the `pause` trap. Repeat the restore with `recovery_target_action` left unset. Within 60 s the server must be stopped (container exited or not accepting connections), and its log must contain `shutdown` near the recovery target. Then fix it with `promote` and confirm it comes up. If proving this costs more than one extra restore cycle, assert it once and keep it.
- [ ] **Step 5:** Run `sh scripts/pitr-test.sh`; expected exit 0. Then confirm nothing named `hattisar-pitr-test*` is left with `docker ps -a`, `docker volume ls` and `docker network ls`.

### Task 3: Managed-box path, retention and the disk-fill trap in the test

**Files:**
- Modify: `scripts/pitr-test.sh`

**Interfaces:**
- Consumes: helpers from Task 2.
- Produces: functions `pitr_managed`, `retention`, `archive_failure`, run in that order after `pitr_shared`.

- [ ] **Step 1:** `pitr_managed`: `docker run -d` a container `hattisar-pitr-test-box` that mirrors `src/managed/docker.ts:130-144`: image `supabase/postgres:17.6.1.136`, only env `POSTGRES_PASSWORD` (generated), only the volume `hattisar-pitr-test-box` at `/var/lib/postgresql/data`, restart `unless-stopped`, on the test network so `s3` resolves, no published port. Then `docker cp` the binary to `/usr/local/bin/wal-g` and a `walg.yaml` (same keys, a different prefix) to `/etc/wal-g/walg.yaml`, chowned to `postgres` with mode 600. Then `ALTER SYSTEM` with `--config /etc/wal-g/walg.yaml` in the commands, and `docker restart`.
- [ ] **Step 2:** Run the same write, backup, T and write sequence as Task 2, with a `docker stop` / `docker start` in the middle, and assert that archiving still works afterwards. Restore with a `--rm` helper `docker run` on the same volume, mounting the binary and config read-only. Make the same assertions as Task 2 step 3.
- [ ] **Step 3:** `retention`: take a second `backup-push` on the managed box, run `wal-g … delete retain FULL 1 --confirm`, and assert that `backup-list` shows exactly one backup.
- [ ] **Step 4:** `archive_failure`: remove `/usr/local/bin/wal-g` from the managed box (`docker exec -u root … rm`), insert rows and `pg_switch_wal()`, then assert that `pg_stat_archiver.failed_count` rises above 0 within 30 s. This is the docs' monitoring check.
- [ ] **Step 5:** Run the whole script; expected exit 0, nothing left behind, `shellcheck` clean. Record the wall time in the report.

### Task 4: The docs

**Files:**
- Create: `docs/pitr.md`
- Modify: `docs/design.md` §8 (the "Docs state plainly" bullet) and §14 (the roadmap line), `README.md` (the three PITR mentions at the Backups / known-limitations spots), `docs/upgrading-studio.md` (re-run `scripts/pitr-test.sh` on a `supabase/postgres` bump)

**Interfaces:**
- Consumes: the exact commands proven in `scripts/pitr-test.sh` (Tasks 1–3). The docs must not show a command the script did not prove, except host cron lines and real-S3 endpoint notes, which are marked untested.

- [ ] **Step 1:** Write `docs/pitr.md` with these sections:
  1. What this is: whole box, not one project; the RPO of about 60 s; tested against S3-compatible RustFS.
  2. Build WAL-G.
  3. S3 prefix and keys (D5), and encryption with the key-loss warning (D7).
  4. Managed boxes, as the main case: `docker cp`, `ALTER SYSTEM`, restart, first backup, the cron line, the combined archiving check proven in `scripts/pitr-test.sh` (`.ready` backlog, `failed_count`, `last_archived_time`), and the disk-fill trap if the container is recreated by hand.
  5. The shared box, framed as dev-only: `compose.walg.yml`, plus `compose.override.yml` in a release dir.
  6. Restore walkthrough: stop hattisar, stop the box, safety copy, empty, `backup-fetch`, recovery settings with `promote` and why, `recovery.signal`, start, clean up, new base backup, start hattisar.
  7. After a restore: the reconciliation table from research §5.
  8. Getting back one project: restore a clone, `pg_dump` it, use hattisar's normal restore.
  9. What is not tested.
- [ ] **Step 2:** Update `design.md` §8: replace the last bullet with one that names `docs/pitr.md` and states that the recipe is box-level and lives outside hattisar. In §14, mark the WAL-G recipe as shipped in `docs/pitr.md`. In `README.md`, point the PITR mentions at `docs/pitr.md`. Add the pin-bump line to `docs/upgrading-studio.md`.
- [ ] **Step 3:** `pnpm lint` passes (Biome may check markdown; if not, just proofread links). Check that every relative link resolves.

### Task 5: CI workflow

**Files:**
- Create: `.github/workflows/pitr.yml`

- [ ] **Step 1:** The workflow is named `PITR recipe`. Triggers: `workflow_dispatch`; `schedule` weekly (`cron: "17 4 * * 1"`); `push` and `pull_request` with a paths filter on `docker/wal-g/**`, `docker/compose.walg.yml`, `scripts/pitr-test.sh`, `docker/compose.yml`, `docker/compose.dev.yml`, `src/managed/service.ts` and `.github/workflows/pitr.yml`. It has one job on `ubuntu-latest` with `timeout-minutes: 30` that runs `sh scripts/pitr-test.sh`, with `permissions: contents: read`. On failure it dumps the test containers' logs (a function in the script, or a step running `docker logs` for each `hattisar-pitr-test` container).
- [ ] **Step 2:** `actionlint .github/workflows/pitr.yml` is clean, if installed. Otherwise check the YAML by eye against `ci.yml`.
