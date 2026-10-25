# Postgres 18 boxes and Postgres 15 restores (#34, #35) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back up and restore Postgres 18 boxes (#34) and report a restore into Postgres 15 as the success it is (#35).

**Architecture:** The hattisar image ships `postgresql18-client` instead of 17 (pg_dump/pg_restore handle older servers), and E1's upper bound moves to 18. pg_restore's known version-skew errors (a `SET` of a configuration parameter the older target server does not know, such as `transaction_timeout`) stop failing a restore when they are the only errors; any other error still fails it.

**Tech Stack:** TypeScript, vitest, Docker (`node:24-alpine`, Alpine 3.24, `postgresql18-client`).

**Spec:** issues #34 and #35, the E3 spike `.superpowers/e3-research.md` (the two version bugs), design §5 and §8.

## Global Constraints

- E1 bounds: `server_version_num` ≥ 150000 and < 190000. Above: `Postgres 18 or older is required; this server is version <major>` (replaces the 17 message).
- Benign pg_restore errors: only `unrecognized configuration parameter "<name>"` from a `SET` in pg_restore's preamble, for any `<name>`. Exit code 1 with only such errors = success, and the tolerated lines are logged once as a warning (no secrets; reuse `redact`). Any other `error:` line keeps today's failure.
- Never read `docker/.env`. Throwaway Docker objects only, named `hattisar-pg18-*`, removed after. The user allowed rebuilding the local dev stack; integration tests may run locally against it (`pnpm stack:up`, then `pnpm test:it`).

## Review Focus

- A real restore error mixed with a benign SET error must still fail.
- pg_restore stderr is kept as a 4 KiB tail: the benign check must not pass when the tail cut off an earlier real error (if pg_restore reports a count, e.g. `warning: errors ignored on restore: N`, check N against the benign lines seen).
- The shared and managed boxes (17.6) keep working with the 18 client (dump, restore, `--list`).

---

### Task 1: Ship the Postgres 18 client and accept Postgres 18 boxes (#34)

**Files:** `docker/Dockerfile`, `src/boxes/e1.ts`, `test/unit/boxes-e1.test.ts`, `test/integration/boxes.test.ts` (the PG18 refusal test becomes acceptance).

- [ ] **Step 1:** Unit: 180000 → `[]`; 190000 → exactly `["Postgres 18 or older is required; this server is version 19"]`. RED, then change `MAX_SERVER_VERSION_NUM` to 190000 and the message; GREEN.
- [ ] **Step 2:** Dockerfile: `postgresql18-client`. Build the runtime target under a throwaway tag (`docker build --target runtime -t hattisar-pg18-check -f docker/Dockerfile .`), confirm `pg_dump --version` prints 18, remove the tag.
- [ ] **Step 3:** Integration: the PG18 box registers (302), a project is created on it, `GET /_hs/projects/<ref>/dump` returns 200 with a body starting `PGDMP`, then delete, purge, remove the box. Reuse the plain-box helpers in the file.

### Task 2: Tolerate pg_restore's version-skew SET errors (#35)

**Files:** `src/backups/pg-restore.ts`, its unit test file, an integration test restoring into a `postgres:15-alpine` box.

- [ ] **Step 1:** Reproduce first with throwaway containers and the Task 1 client: dump a PG17 database with pg_dump 18, restore into PG15 with pg_restore 18 using hattisar's exact arguments; record stderr verbatim in the report. If it no longer fails, say so and still add the integration test.
- [ ] **Step 2:** Unit tests for an exported pure function `onlyVersionSkewErrors(stderr: string): boolean`: true for only `unrecognized configuration parameter` errors; false when any other `error:` line is present; false when a reported error count exceeds the benign errors seen; false for stderr with no error lines.
- [ ] **Step 3:** `runPgRestore` resolves on exit code 1 when `onlyVersionSkewErrors(stderr)` and the run had a connection (`--list` never tolerates), logging one warning.
- [ ] **Step 4:** Integration: register a `postgres:15-alpine` box, create a project, write a row as the owner, back it up the way other backup integration tests do, restore into the same project, assert the restore is reported done and the row is there; clean up like the other plain-box tests.

### Task 3: Docs

**Files:** `docs/design.md` (§5 E1 bounds and the #34 sentence; §8 "image ships PostgreSQL 17 client" and restore error handling), `README.md` (known limitations: drop the PG18 and PG15 caveats).

- [ ] **Step 1:** Update as above; `pnpm lint`.
