# hattisar — v1 Task Breakdown

> **Goal:** [`GOAL.md`](./GOAL.md) · **Spec:** [`docs/design.md`](./docs/design.md) ·
> **Rulings:** PR #1 (v1), #8 (follow-ups), #9 (Settings)

## Phases

- [x] **Spike** — Task 1 foundation · Task 2 Studio proxy core · Task 3 routing e2e (GO/NO-GO)
- [x] **Core** — Task 4 registry · Task 5 auth + shell · Task 6 boxes · Task 7 projects · Task 8 soft delete
- [x] **Studio polish** — Task 9
- [x] **Backups** — Task 10 download + S3 + manual · Task 11 schedules, retention, restore
- [x] **Managed boxes** — Task 12
- [x] **Ship** — Task 13 CI, docs, licence

## Cross-cutting

- No silent default DB · escaped SQL · encrypted secrets · label-scoped Docker (see `AGENTS.md`)

## Decided

Everything decided is in `docs/design.md`; the PRs above keep the rulings.

## Open questions

- GitHub remote: intended `github.com/itsbohara/hattisar` (public, Apache-2.0) — not created yet.
