# Plain-Postgres boxes (E3, issue #23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register any self-managed Postgres 15–17 whose admin is a real superuser, not only `supabase/postgres`.

**Architecture:** The E1 registration check stops requiring the Supabase roles `supabase_admin`, `anon`, `authenticated`, `service_role`; no hattisar code uses them (spike: project databases on supabase/postgres are already plain). E1 gains an upper bound at the bundled client major (17) because `pg_dump` 17 refuses newer servers (#34 lifts it). Everything else (create, baseline, lifecycle, backups, pooler) is unchanged; the spike measured it working on stock 15/17/18 as superuser.

**Tech Stack:** TypeScript, vitest, pg; integration tests against the CI stack.

**Spec:** `.superpowers/e3-research.md` (spike, with measurements) and the approved decisions: go narrow (option c); drop the four role checks for every box; keep version, extension and superuser checks; never create Supabase roles/schemas on a user's server; hosted Postgres is #33; PG18 dump #34; PG15 restore #35.

## Global Constraints

- E1 problems, verbatim: below 15 keeps `Postgres 15 or newer is required; this server is version <major>`; above 17 adds `Postgres 17 or older is required; this server is version <major>`. Extension and superuser messages unchanged.
- `MAX_SERVER_VERSION_NUM` is below `180000` (any 17.x passes).
- No change to `sql/baseline.sql`, project create, pooler, backups.
- Never read `docker/.env`; integration tests run in CI only (the controller does not run `test:it` locally).

## Review Focus

- A stock Postgres box going through the full project life: register, create project, connect as owner, soft delete, restore, purge, remove box.
- A PG18 server is refused with the new message, not accepted and broken at first backup.
- The shared box and managed boxes still pass E1 (no regression from removing roles).

---

### Task 1: E1 without Supabase roles, capped at 17

**Files:**
- Modify: `src/boxes/e1.ts`, `test/unit/boxes-e1.test.ts`, `test/unit/boxes-app.test.ts:131-136`, `test/unit/managed-service.test.ts:196-198` (fixture strings only), `test/integration/boxes.test.ts`

- [ ] **Step 1:** Unit tests in `boxes-e1.test.ts`: a facts object with no Supabase roles, version 170006, extensions present, superuser → `[]`; version 180000 → exactly `["Postgres 17 or older is required; this server is version 18"]`; 140000 keeps the old message. Remove assertions on `Missing role:`.
- [ ] **Step 2:** Run `pnpm test -- boxes-e1`; expected FAIL.
- [ ] **Step 3:** In `e1.ts` remove `REQUIRED_ROLES`, the `roles` fact and its query; add `MAX_SERVER_VERSION_NUM = 180000` (exclusive) and the message above. Update the other unit fixtures that used `Missing role:` strings to a still-real problem (e.g. `Extension not available: pg_stat_statements`).
- [ ] **Step 4:** Integration (`boxes.test.ts`): replace "lists the missing roles of a role-less plain Postgres" with a test that registers the plain `postgres:17-alpine` box (302), creates a project on it through the same route the other integration tests use, connects with the project's direct connection string as the owner and runs `select 1`, then deletes and purges the project and removes the box. Use existing helpers in `test/integration/` (read `projects-*.test.ts` for project create/purge helpers). Add a test that a `postgres:18-alpine` server is refused with the new message (start it the same way the file starts `PLAIN_PG`, and remove it in the same teardown).
- [ ] **Step 5:** `pnpm lint && pnpm typecheck && pnpm test`; integration tests compile (`pnpm typecheck` covers them); CI runs them.

### Task 2: Docs

**Files:**
- Modify: `docs/design.md` §5 (E1 paragraph at ~225-230, plus the box kinds text if it says registered boxes must be supabase/postgres), §14 roadmap line for E3; `README.md` (the line ~347 listing plain-Postgres boxes as out of scope, the Boxes section's register requirements); any UI hint text in `src/ui/` that lists required roles (grep `supabase_admin`).

- [ ] **Step 1:** design §5 E1: version 15–17, extensions, superuser (needed for `pg_stat_statements` in the baseline; `ALTER SCHEMA public OWNER` does not need it on 15+). State that any self-managed Postgres passes; hosted Postgres without a true superuser is #33.
- [ ] **Step 2:** README: registered boxes can be any self-managed Postgres 15–17 with a superuser admin; Query Performance needs `shared_preload_libraries = 'pg_stat_statements'`; a new table shows a harmless `role "anon" does not exist` toast from Studio's Data API toggle. Remove plain-Postgres from the out-of-scope list.
- [ ] **Step 3:** `pnpm lint`; links resolve.
