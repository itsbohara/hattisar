# Operator mounts for managed boxes (#30) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New managed boxes get operator-configured read-only bind mounts (the WAL-G binary and a per-box WAL-G config), so the PITR recipe needs no `docker cp` for them and the files survive a container recreation that repeats the same spec.

**Architecture:** A new setting `HATTISAR_MANAGED_BOX_MOUNTS` lists bind mounts; `{box}` in a source is replaced by the box name. hattisar adds them, read-only, to every managed container it creates. Existing containers are unchanged (hattisar never recreates them). Env vars are deliberately not offered: WAL-G reads `--config`, and env would put secrets in `docker inspect`.

**Tech Stack:** TypeScript, dockerode, vitest.

**Spec:** issue #30; design §10 (managed boxes), §11 (configuration); `docs/pitr.md` (managed-box section).

## Global Constraints

- Format: comma-separated `source:target`. Empty or unset = no mounts. Each `source` and `target` is an absolute path; `source` may contain `{box}` (any number of times, nothing else is a placeholder); neither may contain `..` segments, `,` or `:` beyond the separator. `target` must not be `/var/lib/postgresql/data` or inside it. Targets must be unique.
- A bad value fails config load naming the variable and the entry: `HATTISAR_MANAGED_BOX_MOUNTS: <entry>: <reason>`.
- Mounts are `{ Type: "bind", Source, Target, ReadOnly: true }`. A missing source makes Docker refuse the create; the box creation then fails with Docker's message (existing error path), and nothing labelled is left behind (existing rollback).
- compose.yml passes `HATTISAR_MANAGED_BOX_MOUNTS: ${HATTISAR_MANAGED_BOX_MOUNTS:-}`; `docker/env.example` gets a commented example line.
- Never read `docker/.env`. Do not run integration tests or docker against the user's stack; the controller does a live check.

## Review Focus

- `{box}` substitution cannot produce a path outside the operator's intent: box names are `^[a-z][a-z0-9-]{2,39}$`, so no `/` or `..`; assert that in a test.
- A mount on the data directory is refused at load, not at box creation.
- Containers of existing boxes are never touched by this setting.

---

### Task 1: Parse the setting

**Files:** `src/config.ts`, `test/unit/config.test.ts` (and the env fixtures the config tests use).

- [ ] **Step 1:** Unit tests: unset → `[]`; two entries parsed to `{ source, target }`; `{box}` kept verbatim in `source`; each rejection above produces the exact error format; whitespace around entries trimmed.
- [ ] **Step 2:** Add `managedBoxMounts: { source: string; target: string }[]` to the config.

### Task 2: Apply the mounts to new managed containers

**Files:** `src/managed/docker.ts` (`ContainerSpec` gains `mounts: { source: string; target: string }[]`, resolved), `src/managed/service.ts` (resolves `{box}` from config when building the spec), `src/main.ts`/`src/app.ts` wiring as needed, `docker/compose.yml`, `docker/env.example`, tests `test/unit/managed-service.test.ts` and any docker-adapter unit test.

- [ ] **Step 1:** Unit tests: the spec for box `billing` with mounts `/opt/w/{box}.yaml:/etc/wal-g/walg.yaml` gets source `/opt/w/billing.yaml`; the Docker create body has the bind mounts with `ReadOnly: true` after the data volume; no mounts configured → body unchanged from today.
- [ ] **Step 2:** Implement; wire config through.

### Task 3: Docs

**Files:** `docs/design.md` (§10, §11 table), `README.md` (config table), `docs/pitr.md` (managed boxes: with the setting, new boxes need no `docker cp`; the per-box config file needs a unique `WALG_S3_PREFIX` and must be readable by the container's `postgres` user — give the command to read its uid from the image; existing boxes keep the `docker cp` steps; a missing source makes box creation fail).

- [ ] **Step 1:** Write; `pnpm lint`; links resolve.
