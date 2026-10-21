# Agent Rules

## Project Overview

**hattisar** (हात्तीसार, "elephant stable") — multi-project databases for self-hosted Supabase
Studio. A project is a Postgres database on a box; one stock Studio serves them all, with hattisar
in front choosing the database per request.

**Read first:**
- [`docs/design.md`](./docs/design.md) — the spec. Binding.
- [`GOAL.md`](./GOAL.md) and [`TASK.md`](./TASK.md) — v1 done-ness and progress.

## Architecture

```
src/
  config.ts  app.ts  main.ts  jobs.ts
  studio/     proxy in front of Studio: platform routes, pg-meta routing, pass-through
  registry/   SQLite (better-sqlite3), migrations, secrets at rest
  auth/       single admin login, sessions, canAccess seam
  boxes/      shared / registered / managed boxes, E1 check
  projects/   create, credentials, soft delete, purge
  backups/    pg_dump/pg_restore, S3, schedules, retention
  managed/    Docker (via socket proxy) for managed boxes
  ui/         Hono JSX pages + static assets
  api/        JSON API under /_hs/api/v1, API-token auth
cli/          hattisar CLI: separate zero-dependency package (pnpm build:cli)
sql/          baseline.sql applied to every new project db
docker/       compose.yml (lean stack), compose.dev.yml, compose.source.yml, Dockerfile, volumes/
test/unit  test/integration  e2e/
```

Stack: TypeScript on Node 24, pnpm, Hono, better-sqlite3, pg, crypto-js, dockerode, AWS SDK v3,
vitest, Playwright, Biome.

## Commands

`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm stack:up` / `pnpm stack:down` ·
`pnpm test:it` (needs stack) · `pnpm test:e2e` (needs stack)

## Hard Invariants

- **No silent default DB.** Nothing reaches postgres-meta without hattisar setting
  `x-connection-encrypted` for the ref in the URL. Unresolvable ref → 404, never pass-through.
- **Escape all SQL identifiers/literals.** Never interpolate raw.
- **Secrets encrypted at rest**, never in logs, argv or errors.
- **Managed boxes:** only touch Docker objects labelled `hattisar.managed=true`.
- **Pinned Studio/meta/postgres/supavisor images** change only with the routing e2e passing.

## Conventions

- Match surrounding code. Comments only for traps, load-bearing negatives, non-local reasons.
- Commits split by layer (deps / config / lib / api / ui / tests / docs); no co-author footer.
- Plans in `docs/plans/` exist only while their work is in flight. Delete a plan in the change that
  lands it: `docs/design.md` must already describe the shipped behaviour, the PR description keeps
  the rulings, and git history keeps the plan.

## Rules & References

- [`docs/agents/interaction-guidelines.md`](./docs/agents/interaction-guidelines.md)
- [`docs/agents/rules/context-mode.md`](./docs/agents/rules/context-mode.md)
