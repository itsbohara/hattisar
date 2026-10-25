# Re-sync a box's pooler tenant (#31) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An action that rebuilds one box's pooler tenant (new role password, then PUT) so a box whose `hattisar_pooler_*` role drifted from Supavisor (for example after a point-in-time restore) works again without touching Supavisor by hand.

**Architecture:** `PoolerTenants` gains `resync(box)`, queued on the box like ensure/drop. For an eligible managed or registered box it runs the full create path with the stored tenant id (or a new id when there is none) and reports the outcome instead of only logging it. The Boxes page, the JSON API and the CLI call it.

**Tech Stack:** TypeScript, Hono JSX, vitest; CLI zero-dependency package.

**Spec:** issue #31; design §5.1 (J3: tenant ids, per-tenant role, ensure/drop, scrubbing); `docs/pitr.md` reconciliation table.

## Global Constraints

- `resync(box: Box): Promise<ResyncResult>` where `type ResyncResult = { ok: true; tenant: string } | { ok: false; problem: string }`.
- Refused, with these exact problems: shared box → `The shared box's pooler is configured by pooler.exs.`; ineligible box (registered with sslmode `require`/`verify-full`) → `This box has no pooler: it requires TLS.`; box gone → `Box not found.` (API/UI turn that into 404).
- On success the tenant id stays the stored one (fixed across renames, §5.1); a box with no tenant yet gets `tenantIdFor(...)` as ensure does.
- On failure: `problem` is `Pooler tenant not re-synced: <scrubbed message>` (scrubbed of the generated password and the box admin password, like today's warnings), and the stored tenant fields are left as they were.
- A PUT on an existing tenant terminates its pools: the UI says so next to the button ("Drops open pooled connections."), and the button uses the same confirm pattern as Remove.
- Routes: UI `POST /_hs/boxes/:id/pooler/resync` (redirect back to the Boxes page with the outcome shown the way the page already shows messages; read `src/boxes/routes.tsx` and `src/ui/pages/boxes.tsx`); API `POST /_hs/api/v1/boxes/:id/pooler/resync` → 200 `{ "tenant": "<id>" }`, 400 `{ "problems": [...] }`, 404 for an unknown id, following `src/api/` conventions (auth, errors §15.3). CLI: `hattisar boxes resync-pooler <id>` printing `Re-synced pooler tenant <tenant>` (`--json` prints the API JSON); usage error exit 2, API error exit 1.
- Never read `docker/.env`; integration tests run in CI.

## Review Focus

- A resync racing an ensure or drop for the same box: it must go through the same per-box queue.
- A resync of a box whose row disappears while queued returns `Box not found.` and creates nothing.
- Secrets: the new password and the admin password never reach the problem text, logs or API output.
- The shared box can never be resynced through any of the three entry points.

---

### Task 1: `resync` in PoolerTenants

**Files:** `src/pooler/tenants.ts`, `test/unit/pooler-tenants.test.ts` (uses `test/helpers/pooler.ts` / the fakes the file already has), and `RecordingPooler` in `test/helpers/pooler.ts` gains `resync`.

- [ ] **Step 1:** Unit tests: resync of a managed box with a tenant → new role password installed and one PUT with the stored id, result `{ok: true, tenant}`; a box without a tenant → creates with `tenantIdFor` and stores the fields; shared → refused message; TLS registered box → refused message; PUT failure → `{ok:false}` with scrubbed problem and fields unchanged; row deleted before the queued step runs → `Box not found.`, no API call; resync queued behind an ensure runs after it.
- [ ] **Step 2:** Implement by making `create` return the error (or undefined) instead of only warning, so `ensure` keeps warning and `resync` reports. Keep `ensure`'s behaviour unchanged.

### Task 2: UI, API and CLI

**Files:** `src/boxes/routes.tsx`, `src/ui/pages/boxes.tsx`, `src/api/routes.ts` (or a new `src/api/boxes.ts` if routes are split per resource elsewhere), `src/app.ts` wiring if needed, `cli/src/commands/boxes.ts`, `cli/README.md`, tests: `test/unit/boxes-app.test.ts`, `test/unit/api-app.test.ts`, `test/unit/cli-commands.test.ts`.

- [ ] **Step 1:** Unit tests per entry point: success, each refusal, 404, and that the shared box row shows no Re-sync button.
- [ ] **Step 2:** Implement; the Re-sync button sits in the Pooler cell of boxes with a tenant (and "Pooler pending" boxes, which resync also fixes), with the "Drops open pooled connections." hint.

### Task 3: Integration and docs

**Files:** `test/integration/pooler.test.ts`, `docs/design.md` (§5.1, §15.4 endpoint list, §15.5 CLI), `README.md` if it lists box actions, `docs/pitr.md` (the reconciliation rows that say to delete the tenant in Supavisor now point to Re-sync pooler).

- [ ] **Step 1:** Integration: on the managed box the pooler test already uses, change the `hattisar_pooler_*` role password directly as the box admin (simulating a restore), assert a pooler connection fails, call the API resync, assert 200 and that a pooler connection works again.
- [ ] **Step 2:** Docs as listed; `pnpm lint`.
