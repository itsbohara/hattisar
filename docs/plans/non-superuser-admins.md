# Boxes with a non-superuser admin (#33, groundwork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register a box whose admin is not a superuser but has CREATEDB and CREATEROLE — the shape of RDS, Aurora, Neon and Supabase cloud — and run the full project life on it.

**Architecture:** E1 accepts a superuser, or a non-superuser with `rolcreatedb` and `rolcreaterole`, and records which one (`boxes.admin_superuser`). On a non-superuser box: project create grants the owner role to the admin before `CREATE DATABASE … OWNER`; `pg_stat_statements` is created only if the admin may (skipped on `insufficient_privilege`); the box is never pooled (Supavisor's auth query needs `pg_authid`), so it shows "Direct only".

**Tech Stack:** TypeScript, pg, better-sqlite3 migrations, vitest.

**Spec:** issue #33; the E3 spike `.superpowers/e3-research.md` §2b (measured: with the grant and without `pg_stat_statements`, create, dump, restore with `--role=<owner>`, soft delete, undelete and purge all work as a CREATEDB/CREATEROLE admin on 15/17/18; `get_auth` fails on `pg_authid`) and §5–§6(b); design §5, §5.1, §7.

## Global Constraints

- E1 problem for an admin that is neither: `Admin user <name> needs to be a superuser, or have CREATEDB and CREATEROLE` (replaces `… is not a superuser`).
- Migration `005_admin_superuser.sql`: `ALTER TABLE boxes ADD COLUMN admin_superuser INTEGER NOT NULL DEFAULT 1`. `Box.adminSuperuser: boolean`. Register and edit store E1's fact; shared and managed boxes are always superuser.
- Grant: `GRANT <owner> TO <admin>` (both `pg.escapeIdentifier`), only when `!box.adminSuperuser`, right after the owner role is created and before `CREATE DATABASE`.
- Baseline: `pg_stat_statements` leaves `sql/baseline.sql`; after the baseline, run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions` separately and ignore only SQLSTATE `42501`; any other error fails create as today.
- Pooler: `isPoolerEligible` also requires `adminSuperuser`; such a box gets "Direct only" and ensure drops any tenant as for TLS boxes.
- Support is claimed only as "tested with a CREATEDB/CREATEROLE admin on stock Postgres 15–18"; real RDS/Neon runs stay open on #33.
- Never read `docker/.env`; integration tests run in CI.

## Review Focus

- An admin with only one of CREATEDB/CREATEROLE is refused.
- Purge on a non-superuser box drops the owner role even though the admin is a member of it.
- Editing a box from a superuser admin to a non-superuser one turns its pooler off (drop) and later projects get the grant.
- Existing boxes (rows before the migration) keep working as superuser boxes.

---

### Task 1: E1 and the stored fact

**Files:** `src/boxes/e1.ts`, `src/registry/migrations/005_admin_superuser.sql`, `src/registry/boxes.ts`, `src/boxes/service.ts` (register/edit store the fact), `src/managed/service.ts` and the shared-box seeding (always true), tests `test/unit/boxes-e1.test.ts`, registry and boxes-app/service tests.

- [ ] **Step 1:** Unit tests: superuser → `[]`; non-superuser with both → `[]`; with only one or none → the new problem; registry round-trips `adminSuperuser`; register stores `false` for a non-superuser box.
- [ ] **Step 2:** Implement; `E1Result` carries the facts needed (or a `superuser` boolean) so the service can store it.

### Task 2: Project create, baseline and pooler on a non-superuser box

**Files:** `src/projects/service.ts`, `sql/baseline.sql`, `src/projects/baseline.ts` if needed, `src/pooler/tenant-spec.ts`, tests `test/unit/projects-*.test.ts`, `test/unit/pooler-tenant-spec.test.ts`, `test/unit/pooler-tenants.test.ts`.

- [ ] **Step 1:** Unit tests: the grant statement is issued (escaped) before `CREATE DATABASE` only for non-superuser boxes; `pg_stat_statements` failing with `42501` does not fail create, another error does; `isPoolerEligible` false and `poolerStatus` `direct` for a non-superuser `sslmode=disable` box; ensure drops an existing tenant for such a box.
- [ ] **Step 2:** Implement.

### Task 3: Integration and docs

**Files:** `test/integration/boxes.test.ts` (or a new file following its plain-box helpers), `docs/design.md` (§5 E1, §5.1 eligibility, §7 create steps), `README.md` (registered boxes line; the #33 caveat).

- [ ] **Step 1:** Integration: stock `postgres:17-alpine`; as its superuser create `LOGIN CREATEDB CREATEROLE` admin with a generated password; register the box with that admin (`sslmode=disable`) → 302 and the Boxes page shows "Direct only"; create a project; owner connects; back up to S3 and restore into the project (follow the PG15 restore test); soft delete, restore from Trash, delete, purge; owner role and database gone on the server; remove the box. A second admin with only CREATEDB is refused with the new message.
- [ ] **Step 2:** Docs; `pnpm lint`.
