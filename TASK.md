# hattisar — v1 Task Breakdown

> **Goal:** [`GOAL.md`](./GOAL.md) · **Spec:** [`docs/design.md`](./docs/design.md) ·
> **Plan:** [`docs/plans/v1.md`](./docs/plans/v1.md)
>
> **Source idea / locked decisions:**
> - Concept doc: `~/code/ideastorm/concepts/hattisar/README.md`
> - Memory note: `~/code/ideastorm/memory/project-hattisar.md`
>
> Those live in the ideastorm sandbox (planning only). This repo is the build; `docs/design.md`
> wins where they disagree.

## Stack overrides vs. the concept doc

None — the concept locked TypeScript + Hono (Q12) and the lean stack (Q11).

## Phases

- [ ] **Spike** — Task 1 foundation · Task 2 Studio proxy core · Task 3 routing e2e (GO/NO-GO)
- [ ] **Core** — Task 4 registry · Task 5 auth + shell · Task 6 boxes · Task 7 projects · Task 8 soft delete
- [ ] **Studio polish** — Task 9
- [ ] **Backups** — Task 10 download + S3 + manual · Task 11 schedules, retention, restore
- [ ] **Managed boxes** — Task 12
- [ ] **Ship** — Task 13 CI, docs, licence

## Cross-cutting

- No silent default DB · escaped SQL · encrypted secrets · label-scoped Docker (see `AGENTS.md`)

## Decided

Q1–Q17 in the concept doc; consolidated into `docs/design.md`.

## Open questions

- GitHub remote: intended `github.com/itsbohara/hattisar` (public, Apache-2.0) — not created yet.
