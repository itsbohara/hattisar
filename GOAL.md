# hattisar — v1 Goal

**Project:** hattisar — multi-project databases for self-hosted Supabase Studio
**Type:** service (web app + reverse proxy), Docker Compose
**Stack:** TypeScript / Node 24 / Hono / SQLite; stock Supabase Studio, postgres-meta, Postgres, Supavisor

## The one-sentence goal

> Create a Postgres database in seconds — on a shared dev box or a dedicated one — and browse it in
> the real Supabase Studio, with many projects behind one login.

Differentiator that must work: **one unmodified Studio, many databases**, chosen per request.

## A user can, end to end

1. Log in, create project `notes-app` on the shared box (warned: development only).
2. Open it in Studio, create tables, run SQL — only `notes-app`'s database is touched.
3. Copy its pooler connection string into an app; that role cannot reach other projects.
4. Register a production box (or start a managed one) and create a project there.
5. Back up to S3 on a schedule, restore into the same or a new project.
6. Delete a project, restore it within 7 days, or let it purge.

## Definition of Done

- [ ] Routing e2e GO: every Studio screen for project B hits B's database only
- [ ] All plan tasks 1–13 complete with reviews clean or rulings recorded
- [ ] `pnpm lint typecheck test test:it test:e2e` all pass locally
- [ ] CI workflow present and runs the same
- [ ] README explains setup, security notes, "not PITR", "Not affiliated with Supabase"

## Out of v1

See `docs/design.md` §14.
