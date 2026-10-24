# J3: Pooler for Managed and Registered Boxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every managed box, and every registered box with `sslmode = disable`, gets its own Supavisor tenant, so its
projects get session and transaction pooler strings (plus direct) in the UI, API and CLI (issue #21).

**Architecture:** A new `src/pooler/` layer talks to Supavisor's tenant API (`http://supavisor:4000`, HS256 JWT signed
with `POOLER_JWT_SECRET`). It installs a `hattisar_pooler` role and `hattisar_pooler.get_auth` function on the box, and
ensures, drops and reconciles one tenant per box. Box services call it on create, register, edit and remove. Boot
reconciles in the background. Connection strings use `HATTISAR_PUBLIC_HOST` for pooler strings. The shared tenant
(`pooler.exs`) is untouched.

**Tech Stack:** TypeScript on Node 24, Hono, better-sqlite3, pg, `node:crypto` (HMAC for the JWT, no new dependency),
vitest.

**Spec:** `docs/design.md` §5.1 (tenant lifecycle), §4 (pooler fields), §7 J1 (connection strings), §10, §11, §15.5.
Verified upstream facts are in `.superpowers/j3-research.md`.

## Global Constraints

- **Escape all SQL.** Use `pg.escapeIdentifier` and `pg.escapeLiteral`. The role password goes in as
  `scramVerifier(password)` (`src/projects/owner-password.ts`), never plaintext.
- **Keep secrets out.** The generated pooler password, `POOLER_JWT_SECRET` and the JWT never appear in logs, argv,
  thrown messages, HTML or API responses. Scrub Supavisor error bodies with `safeErrorMessage(…, password)`.
- **Managed boxes:** Docker calls stay as they are. Only objects labelled `hattisar.managed=true` are touched; the pooler
  layer never calls Docker.
- **Never PUT an unchanged existing tenant.** Supavisor terminates that tenant's pools on every update
  (`lib/supavisor/tenants.ex:297-302`).
- **No unit test reaches a real Supavisor or Postgres.** Use a fake `fetch` and a fake `AdminClientRunner`.
- **Do not commit while working.** Each task ends with the commit message to use when committing layer by layer
  afterwards. No co-author footer.
- Match the surrounding code. Comments only for traps, load-bearing negatives and non-local reasons.

## Review Focus

1. No path lets the plaintext pooler password, the JWT or `POOLER_JWT_SECRET` reach a log line, an error message or a
   response.
2. Boot reconcile and edit do `GET` before `PUT`, and only PUT when the tenant is missing or its host or port differ.
3. `pooler_tenant` is written only after a successful PUT. The tenant id is fixed once stored and survives a box rename.
4. Pooler strings use `HATTISAR_PUBLIC_HOST`, never `box.publicHost`. The order is session, transaction, direct, and the
   shared box has no direct string.
5. Registered boxes with `require` or `verify-full` never get a tenant, and editing a box into those modes drops one.

---

### Task 1: Config — pass `POOLER_JWT_SECRET` to hattisar

**Files:**
- Modify: `src/config.ts`, `docker/compose.yml` (hattisar `environment`), `docker/env.example` (comment only)
- Modify test env fixtures that build a full env: `test/unit/config.test.ts`, `api-app`, `app-errors`, `auth-app`,
  `backups-restore`, `cli-commands`, `boxes-app` (each `*.test.ts` that sets `POOLER_TENANT_ID`)

**Interfaces — Produces:** `Config["pooler"]` gains `jwtSecret: string`.

- [ ] Add a failing test to `test/unit/config.test.ts`:
  - `loadConfig(env).pooler.jwtSecret === env.POOLER_JWT_SECRET`
  - Add `"POOLER_JWT_SECRET"` to the `it.each` list of required vars, so a missing value throws `ConfigError`.
- [ ] Run `pnpm test test/unit/config.test.ts`. Expected: FAIL (`jwtSecret` undefined, no throw).
- [ ] Implement: `jwtSecret: read.required("POOLER_JWT_SECRET")`.
  - Compose: `POOLER_JWT_SECRET: ${POOLER_JWT_SECRET}` next to `POOLER_TENANT_ID`.
  - Add the var to every test env fixture.
- [ ] Run `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] Commit: `chore: pass POOLER_JWT_SECRET to hattisar`

### Task 2: Supavisor tenant API client

**Files:**
- Create: `src/pooler/supavisor.ts`
- Test: `test/unit/pooler-supavisor.test.ts`

**Interfaces — Produces:**
```ts
export const SUPAVISOR_API_URL = "http://supavisor:4000";
export function signApiJwt(secret: string, nowSeconds: number): string; // HS256, header {alg:"HS256",typ:"JWT"}, claims {exp: now+60}
export interface TenantUser { db_user: string; db_password: string; mode_type: "transaction"; pool_size: number; is_manager: true }
export interface TenantBody {
  db_host: string; db_port: number; db_database: "postgres"; require_user: false; auth_query: string;
  upstream_ssl: false; ip_version: "auto"; default_pool_size: number; default_max_clients: number; users?: TenantUser[];
}
export interface TenantInfo { dbHost: string; dbPort: number }
export class SupavisorError extends Error { readonly status: number }
export interface TenantApi {
  get(id: string): Promise<TenantInfo | undefined>;       // GET /api/tenants/:id; 404 → undefined
  put(id: string, tenant: TenantBody): Promise<void>;     // PUT body {"tenant": tenant}; 200/201 ok
  remove(id: string): Promise<void>;                      // GET /api/tenants/:id/terminate, then DELETE; 404s ok
}
export class SupavisorApi implements TenantApi {
  constructor(opts: { jwtSecret: string; baseUrl?: string; fetch?: typeof fetch; now?: () => number });
}
```

- [ ] Write failing tests (fake `fetch` recording `url`, `method`, headers and body):
  - `signApiJwt("s", 1000)`:
    - has three base64url parts;
    - the header decodes to `{alg:"HS256",typ:"JWT"}` and the payload to `{exp:1060}`;
    - the signature equals `createHmac("sha256","s").update(h+"."+p).digest("base64url")`.
  - `put("hattisar-b1", body)`:
    - sends `PUT http://supavisor:4000/api/tenants/hattisar-b1` with `content-type: application/json`,
      `authorization: Bearer <jwt>` and a body that is exactly `{"tenant": body}`;
    - an id containing `.` or `/` throws before any fetch.
  - `get`:
    - maps `{"data":{"db_host":"h","db_port":5432,…}}` to `{dbHost:"h",dbPort:5432}`;
    - 404 maps to `undefined`.
  - `remove`:
    - calls `/terminate` and then `DELETE`, in that order;
    - a 404 on either counts as success.
  - A 400 `{"error":"Can't connect the user hattisar_pooler: … pw123 …"}` with the password passed to the scrubber
    throws `SupavisorError` with `status 400`. Its message contains `Can't connect` and not `pw123`, and never
    contains the bearer token.
  - A 403 throws with a fixed message, and a network failure throws `SupavisorError` with `status 0`. The JWT secret
    appears in neither.
- [ ] Run `pnpm test test/unit/pooler-supavisor.test.ts`. Expected: FAIL (module missing).
- [ ] Implement:
  - 10 s `AbortSignal.timeout` per call.
  - `put` takes an optional `scrub?: string`, the password to remove from error text.
  - Error bodies are parsed for `error` only. Never include raw JSON or headers.
- [ ] Run the test again. Expected: PASS. Then `pnpm lint && pnpm typecheck`.
- [ ] Commit: `feat(pooler): add Supavisor tenant API client`

### Task 3: Pooler role SQL, tenant payload, eligibility and tenant id

**Files:**
- Create: `src/pooler/role.ts`, `src/pooler/tenant-spec.ts`
- Test: `test/unit/pooler-role.test.ts`, `test/unit/pooler-tenant-spec.test.ts`

**Interfaces — Produces:**
```ts
// role.ts
export const POOLER_ROLE = "hattisar_pooler";
export const POOLER_AUTH_QUERY = "SELECT * FROM hattisar_pooler.get_auth($1)";
export function installPoolerRole(client: pg.Client, password: string): Promise<void>; // runs in db "postgres"
// tenant-spec.ts
export function isPoolerEligible(box: Pick<Box, "kind" | "sslmode">): boolean; // managed, or registered && sslmode === "disable"
export function tenantIdFor(prefix: string, box: Pick<Box, "id" | "name">, taken: Iterable<string>): string; // `${prefix}-${name}`, else `${prefix}-${name}-${id}`
export function tenantBody(box: Pick<Box, "host" | "port">, password?: string): TenantBody;
export type PoolerStatus = { kind: "tenant"; id: string } | { kind: "pending" } | { kind: "direct" };
export function poolerStatus(box: Box): PoolerStatus; // shared/eligible with tenant → tenant; eligible without → pending; else direct
```
**Consumes:** `scramVerifier` (`src/projects/owner-password.ts`), `TenantBody` (Task 2), `Box` (`src/registry/boxes.ts`).

- [ ] Failing tests for `installPoolerRole`, using a fake `pg.Client` whose `query` records SQL:
  - The role is created when `select 1 from pg_roles where rolname = $1` returns no rows and altered when it does.
    Both statements contain `LOGIN PASSWORD 'SCRAM-SHA-256$4096:` and never the plaintext.
  - Statements include `CREATE SCHEMA IF NOT EXISTS hattisar_pooler` and
    `CREATE OR REPLACE FUNCTION hattisar_pooler.get_auth(p_usename text)` with `SECURITY DEFINER`,
    `SET search_path = ''`, `pg_catalog.pg_authid`, `rolcanlogin`, `NOT rolsuper` and `rolvaliduntil`.
  - Statements include `REVOKE ALL ON FUNCTION hattisar_pooler.get_auth(text) FROM PUBLIC`, and `GRANT USAGE` and
    `GRANT EXECUTE` to `"hattisar_pooler"`.
- [ ] Failing tests for `tenant-spec`:
  - `isPoolerEligible`:
    - `managed` with `disable` is true, `registered` with `disable` is true;
    - `registered` with `require` or `verify-full` is false, and `shared` is false (hattisar never manages it).
  - `tenantIdFor`:
    - `("hattisar", {id:7,name:"b1"}, [])` gives `"hattisar-b1"`;
    - with `"hattisar-b1"` taken it gives `"hattisar-b1-7"`.
  - `tenantBody({host:"hattisar-box-b1",port:5432}, "pw")` deep-equals the §5.1 JSON exactly:
    - `db_database "postgres"`, `require_user false`, `auth_query POOLER_AUTH_QUERY`, `upstream_ssl false`,
      `ip_version "auto"`, `default_pool_size 20`, `default_max_clients 100`;
    - `users[0] = {db_user:"hattisar_pooler", db_password:"pw", mode_type:"transaction", pool_size:20, is_manager:true}`.
  - Without a password the body has no `users` key.
  - `poolerStatus` covers all three kinds.
- [ ] Run `pnpm test test/unit/pooler-role.test.ts test/unit/pooler-tenant-spec.test.ts`. Expected: FAIL.
- [ ] Implement:
  - Generate SQL with `pg.escapeLiteral(scramVerifier(password))`. Run each statement separately.
  - Create the function as the connected admin (a superuser, which E1 requires) so it can read `pg_authid`.
- [ ] Run the tests again. Expected: PASS.
- [ ] Commit: `feat(pooler): add hattisar_pooler role and tenant payload`

### Task 4: Tenant service — ensure, drop, reconcile

**Files:**
- Create: `src/pooler/tenants.ts`
- Test: `test/unit/pooler-tenants.test.ts`, using a real registry in a temp dir as `registry-repositories.test.ts`
  does, a fake `TenantApi` and a fake `AdminClientRunner`

**Interfaces — Produces:**
```ts
export interface PoolerTenants {
  ensure(box: Box): Promise<void>;   // never throws; logs a scrubbed warning on failure
  drop(box: Box): Promise<void>;     // never throws; clears pooler fields when the tenant is gone
  reconcile(): Promise<void>;        // every non-shared box: ensure if eligible, drop if not; rewrite ports from env
}
export function createPoolerTenants(deps: {
  db: Registry; secretKey: Buffer; api: TenantApi; admin: AdminClientRunner;
  tenantPrefix: string; portSession: number; portTransaction: number;
}): PoolerTenants;
```
**Consumes:** Tasks 2–3, `boxConnection` (`src/boxes/service.ts`), `updateBox`/`listBoxes`/`getBoxById`.

- [ ] Write failing tests:
  - **New eligible box:**
    - `admin` is called with db `postgres`, then `api.put` with a body that has `users` and the same password
      `installPoolerRole` got.
    - The row then has `poolerTenant "hattisar-<name>"`, `poolerSessionPort 54322` and `poolerTransactionPort 6543`.
  - **PUT fails** (`SupavisorError 400`): the pooler fields stay null, `ensure` resolves, and `console.warn` was called
    once without the password (spy on it).
  - **Stored tenant, GET matches:** no `put` and no `admin` call. This is the pool-preserving rule.
  - **Stored tenant, host differs:** `put` without a `users` key, and no `admin` call.
  - **Stored tenant, GET returns undefined:** the full flow runs again with a new password, keeping the same stored id.
  - **Renamed box with a stored tenant:** the id is unchanged.
  - **Ineligible box (registered with `require`) with a stored tenant:** `api.remove(id)`, then the three fields are
    set to null.
  - **`drop` when `api.remove` throws:** the fields are cleared anyway, it resolves, and a warning is logged.
  - **`reconcile`:**
    - skips the shared box;
    - rewrites the ports on boxes with a tenant when the configured ports changed;
    - processes boxes one after another;
    - one box failing does not stop the next.
  - **A second `ensure` while the first is running** for the same box does not double-PUT. Serialize per box with a
    promise map.
- [ ] Run `pnpm test test/unit/pooler-tenants.test.ts`. Expected: FAIL.
- [ ] Implement. Generate the password with `randomBytes(32).toString("base64url")`. Pass it to the `put` scrubber.
  Never log it.
- [ ] Run the test again. Expected: PASS.
- [ ] Commit: `feat(pooler): ensure, drop and reconcile box tenants`

### Task 5: Wire tenants into boxes, managed boxes and boot

**Files:**
- Modify:
  - `src/boxes/service.ts`: `BoxServiceDeps` gains `pooler: PoolerTenants`; `registerBox`, `editBox` and `removeBox`
    (now async)
  - `src/boxes/routes.tsx`: `await removeBox`
  - `src/managed/service.ts`: `ManagedBoxDeps.pooler`; `createNow` ensures after `insertBox`; `remove` drops before
    removing the container
  - `src/app.ts`: `createApp(config, registry, managed?, pooler?)`, defaulting to `createPoolerTenants` with
    `new SupavisorApi({ jwtSecret: config.pooler.jwtSecret })`
  - `src/main.ts`: build one `PoolerTenants`, pass it to `createManagedBoxes` and `createApp`, and
    `void pooler.reconcile()` after `serve(...)`
- Test: `test/unit/boxes-app.test.ts`, `test/unit/managed-service.test.ts`, with a recording fake
  `PoolerTenants { ensure, drop, reconcile }`

**Interfaces — Consumes:** `PoolerTenants` (Task 4). **Produces:** `removeBox(deps, box): Promise<RemoveResult>`;
`createManagedBoxes(config, db, secretKey, pooler)`.

- [ ] Write failing tests:
  - Registering a box (E1 passes) calls `ensure` once with the inserted box. A failed E1 calls nothing.
  - Editing a registered box calls `ensure` with the updated row. That covers both pooler cases: `ensure` itself drops
    an ineligible box's tenant.
  - Removing a registered box with no projects calls `drop` before the row is deleted. A box with projects calls
    nothing.
  - A managed `create` calls `ensure` after the row exists. A failed create calls nothing.
  - A managed `remove` calls `drop`.
  - The existing managed lifecycle purge test still removes the box.
- [ ] Run `pnpm test test/unit/boxes-app.test.ts test/unit/managed-service.test.ts`. Expected: FAIL.
- [ ] Implement as listed. Boot reconcile must not delay `serve`, and an error there is caught and logged.
- [ ] Run `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(boxes): register pooler tenants for managed and registered boxes`

### Task 6: Connection strings and the post-rotate pooler refresh

**Files:**
- Modify:
  - `src/projects/connection-strings.ts`
  - `src/projects/access.ts` (`connectionStrings` takes `poolerHost`)
  - `src/projects/routes.tsx:88`, `src/api/projects.ts:122,131`
  - `src/projects/service.ts`: `ProjectServiceDeps.poolerHost: string`
  - `src/app.ts`: `projectServiceDeps` sets `poolerHost: config.publicHost` and `refreshPooler`
  - `src/projects/pooler.ts`: `refreshSharedPooler` becomes `refreshPooler`, for any box with `poolerTenant`
  - `src/boxes/shared.ts`: move `SHARED_POOLER` to `src/pooler/endpoint.ts` as `POOLER_ENDPOINT`
  - `src/projects/lifecycle.ts:103` comment: "on the shared box" becomes "on the box"
  - `sql/baseline.sql:4-6` comment
- Test: `test/unit/projects-connection-strings.test.ts`, `test/unit/api-app.test.ts`

**Interfaces — Produces:**
```ts
export function ownerConnectionStrings(
  box: ProjectEndpoint & Pick<Box, "kind">, project: Pick<Project, "dbName" | "ownerRole">,
  password: string, poolerHost: string,
): ConnectionString[];
export const refreshPooler: PoolerRefresher;
```

- [ ] Write failing tests:
  - **Registered box with a tenant** (`publicHost "db.example.com"`, `publicPort 5433`, tenant `hattisar-b1`,
    `poolerHost "pool.example.com"`): kinds are `["session","transaction","direct"]`.
    - session = `postgresql://hs_x_owner.hattisar-b1:<pw>@pool.example.com:54322/x`
    - direct = `postgresql://hs_x_owner:<pw>@db.example.com:5433/x`
  - **Shared box:** `["session","transaction"]` only.
  - **Box without a tenant:** `["direct"]`.
  - **Masked variants** never contain the password.
  - **API:** `GET /projects/:ref/connections` on a registered box with a tenant returns three entries in that order.
- [ ] Run `pnpm test test/unit/projects-connection-strings.test.ts test/unit/api-app.test.ts`. Expected: FAIL.
- [ ] Implement.
- [ ] Run `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(projects): offer pooler strings on every box with a tenant`

### Task 7: Boxes page pooler column

**Files:**
- Modify: `src/ui/pages/boxes.tsx`, `src/ui/static/*.css` (only if needed)
- Test: `test/unit/boxes-app.test.ts`

**Interfaces — Consumes:** `poolerStatus(box)` (Task 3).

- [ ] Write a failing test. `GET /_hs/boxes` row `data-box="<name>"` contains:
  - the tenant id for a box with a tenant;
  - `Pooler pending` for an eligible box without one;
  - `Direct only` for a registered box with `require`;
  - the shared box shows `POOLER_TENANT_ID`.
- [ ] Run `pnpm test test/unit/boxes-app.test.ts`. Expected: FAIL.
- [ ] Implement a "Pooler" column using the existing table markup.
- [ ] Run the test again. Expected: PASS.
- [ ] Commit: `feat(ui): show each box's pooler tenant`

### Task 8: CLI `projects url --direct`

**Files:**
- Modify: `cli/src/commands/projects.ts`, `cli/README.md`
- Test: `test/unit/cli-commands.test.ts`

- [ ] Write failing tests against the in-process app:
  - **Registered box with a tenant:** `projects url r` prints the session URL. `--direct` prints the direct URL.
    `--transaction` prints the transaction URL.
  - **Shared box:** `--direct` exits 1 with `r has no direct connection`.
  - **Both flags:** `--direct --transaction` exits 2 before any request.
  - `--help` usage shows `[--transaction | --direct]`.
- [ ] Run `pnpm test test/unit/cli-commands.test.ts`. Expected: FAIL.
- [ ] Implement: `options: ["transaction", "direct"]`. Throw `UsageError` when both are set. Find by `kind`.
  - `cli/README.md`: "the session pooler on a box with a tenant, direct otherwise; `--direct` picks the direct
    connection".
- [ ] Run `pnpm test && pnpm build:cli`. Expected: PASS.
- [ ] Commit: `feat(cli): add projects url --direct`

### Task 9: Integration test, then drop this plan

**Files:**
- Create: `test/integration/pooler.test.ts`
- Modify: `test/integration/managed-boxes.test.ts`
- Delete: `docs/plans/j3-pooler.md`

- [ ] Write the integration test (`HATTISAR_IT=1`, stack up, via hattisar's HTTP surface):
  - Register the stack's `db` as box `pooled` (`sslmode disable`). Its Boxes row shows `hattisar-pooled`.
  - Create a project on it. `GET /connections` returns three kinds.
  - A `pg.Client` to `localhost:54322` as `<owner>.hattisar-pooled` with the session URL's password runs
    `select current_database()` and gets the project's db. Do the same on 6543.
  - Rotate the password. The new session URL connects.
  - Delete and purge the project, then remove the box. Connecting as `<owner>.hattisar-pooled` now fails.
  - `managed-boxes.test.ts`: the dedicated box's session string connects from the host.
- [ ] Run `pnpm stack:up && pnpm test:it`. Expected: PASS. Then `pnpm test:e2e` (routing e2e, unchanged images).
- [ ] Delete `docs/plans/j3-pooler.md`. `docs/design.md` §5.1 already describes the behaviour.
- [ ] Commit: `test: cover pooler tenants on registered and managed boxes`, then `docs: drop the landed J3 plan`.

Docs (`docs/design.md`, `README.md`) were updated ahead of the code; commit them as
`docs: specify pooler tenants for managed and registered boxes`.
