# Attached Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a database hattisar did not create be attached as a project, opened in Studio with a user-given login, never altered by hattisar, and removed with Detach.

**Architecture:** A `kind` column on `projects` (`created` | `attached`). Attached rows reuse `owner_role` / `owner_password_enc` for the user's login and store the real `db_name`. A new `src/projects/attach.ts` holds attach / update login / detach / attachable databases; every existing path that alters a database or role refuses attached projects in the service layer; read paths (Studio, connection strings, sizes, dumps) branch on `kind`.

**Tech Stack:** TypeScript on Node 24, Hono + JSX, better-sqlite3, pg, vitest, Biome. CLI is the zero-dependency package in `cli/`.

**Spec:** `docs/design.md` §7.1 "Attached projects", the §15.4 rows `GET /boxes/:id/databases`, `POST /projects/attach`, `PUT /projects/:ref/login`, `POST /projects/:ref/detach`, the `kind` field on the project JSON, and the §15.5 lines `projects attach`, `projects set-login`, `projects detach`, `boxes databases`.

## Global Constraints

- Hattisar never changes an attached database or its login: no `CREATE`/`ALTER`/`DROP ROLE`, no `GRANT`/`REVOKE`, no rename, drop, baseline or extension. No SQL other than reads runs on the box for an attached project.
- Attach is allowed on **registered** boxes only (`box.kind === "registered"`).
- Escape every SQL identifier/literal (`pg.escapeIdentifier` / parameters); never interpolate.
- The login password is stored with `encryptSecret`, never logged, never in argv, scrubbed from errors with `safeErrorMessage(error, password)`.
- Refusal text for lifecycle operations on an attached project, exactly: `` `${ref} is attached; detach it instead` `` (plus a trailing `.` where surrounding messages end with one). API answers 409 for it regardless of busy state.
- Wrong `confirm` on detach: 400, message `` `Type the ref ${ref} to confirm detaching the project.` ``.
- Lock operations (`ProjectOperation`, `status: "active"`): detach `{ action: "detach", holds: "it is being detached" }`; update login `{ action: "update the login of", holds: "its login is being updated" }`.
- Commits split by layer (registry / lib / api / ui / cli / tests / docs), message format `<type>(<scope>): <summary>`, **no co-author footer**.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green after every task.

## Review Focus

1. Attaching a database that a created project (or a Trash entry's `deleted_db_name`) already uses must be refused even if the request bypasses the picker — test in Task 2.
2. A login that connects but to the wrong database / a wrong password must yield a scrubbed error with no registry row — test in Task 2.
3. The hourly purge, Trash restore and managed-box lifecycle hook must never act on an attached row — test in Task 2 (purge/restore refusal) and Task 3 (no `onLifecycle` call on detach).
4. A Supabase-pooler box (`*.pooler.supabase.com`): the attached login is used verbatim, never suffixed twice — test in Task 3.
5. One attached database whose size query fails must not mark its box unreachable or hide created projects' sizes — test in Task 3.

---

### Task 1: Registry — project kind and login columns

**Files:**
- Create: `src/registry/migrations/006_attached_projects.sql`
- Modify: `src/registry/projects.ts`
- Test: `test/unit/registry-repositories.test.ts`

**Interfaces:**
- Produces:
  - `export type ProjectKind = "created" | "attached";`
  - `Project` gains `kind: ProjectKind` and `loginSuperuser: boolean`.
  - `NewProject` gains optional `kind?: ProjectKind` (default `"created"`) and `loginSuperuser?: boolean` (default `false`).
  - `setProjectLogin(db: Registry, id: number, login: string, passwordEnc: string, superuser: boolean): void` — updates `owner_role`, `owner_password_enc`, `login_superuser`.

- [ ] **Step 1: Write failing tests** in `registry-repositories.test.ts`: (a) `insertProject` without `kind` returns `kind: "created", loginSuperuser: false`; (b) `insertProject({ ..., kind: "attached", loginSuperuser: true })` round-trips via `getProjectByRef`; (c) `setProjectLogin` changes `ownerRole`, `ownerPasswordEnc`, `loginSuperuser` and nothing else.
- [ ] **Step 2: Run** `pnpm vitest run test/unit/registry-repositories.test.ts` — expect the three to FAIL.
- [ ] **Step 3: Migration** `006_attached_projects.sql`, same one-statement-per-line shape as `005`:
  ```sql
  ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'created' CHECK (kind IN ('created', 'attached'));
  ALTER TABLE projects ADD COLUMN login_superuser INTEGER NOT NULL DEFAULT 0;
  ```
  Update `COLUMNS` (`kind`, `login_superuser AS loginSuperuser`), the INSERT, and map the integer to boolean the way `boxes.ts` maps `admin_superuser`.
- [ ] **Step 4: Run** the file again, then `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(db): add attached project kind`.

### Task 2: Attach service and lifecycle guards

**Files:**
- Create: `src/projects/attach.ts`
- Modify: `src/projects/service.ts` (rotate guard), `src/projects/lifecycle.ts` (soft delete, restore, purge guards), `src/backups/restore.ts` (`restoreIntoProject` guard)
- Test: create `test/unit/projects-attach.test.ts`; extend `test/unit/projects-lifecycle.test.ts`, `test/unit/backups-restore.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ProjectKind`, `setProjectLogin`, `insertProject` with `kind`).
- Produces (all in `src/projects/attach.ts`):
  - `export function attachedProblem(ref: string): string` → `` `${ref} is attached; detach it instead.` ``
  - `export function isAttached(project: Pick<Project, "kind">): boolean`
  - `export interface AttachForm { name: string; ref: string; boxId: number; database: string; login: string; password: string }`
  - `export async function attachableDatabases(deps: Pick<ProjectServiceDeps, "db" | "secretKey" | "admin">, box: Box): Promise<{ ok: true; databases: string[] } | { ok: false; problem: string }>` — `problem` for a non-registered box: `` `Only registered boxes can attach databases; ${box.name} is ${box.kind}.` ``; box failure: `` `Could not list the databases of box ${box.name}: ${message}` ``.
  - `export async function attachProject(deps: ProjectServiceDeps, form: AttachForm): Promise<CreateResult>`
  - `export async function updateProjectLogin(deps: ProjectServiceDeps, project: Project, box: Box, login: string, password: string): Promise<{ ok: true } | { ok: false; problem: string }>`
  - `export async function detachProject(deps: ProjectServiceDeps, project: Project): Promise<{ ok: true } | { ok: false; problem: string }>`
  - `export function attachedConnection(project: Project, box: Box, secretKey: Buffer): BoxConnection` — box host/port/sslmode, `user: project.ownerRole`, decrypted password. Used by Tasks 3 and 4.

**Rules the code must follow (from §7.1):**
- `attachableDatabases` query (as box admin, database `postgres`):
  `select datname from pg_database where not datistemplate and datname <> '_supabase' and datname !~ '__deleted_\d{8}(_\d+)?$' order by datname`, then drop names that any `listProjectsOnBox(db, box.id)` row has as `dbName` or `deletedDbName`.
- `attachProject` order: `projectFieldProblems(db, {name, ref})`; box exists and is registered; `login` and `password` non-empty (`"Login is required"`, `"Password is required"`); `database` ∈ `attachableDatabases` (`` `Database ${database} cannot be attached on box ${box.name}` ``); then connect **as the login** with `deps.admin({ host, port, sslmode from box, user: login, password }, client => client.query("select rolsuper from pg_roles where rolname = current_user"), database)`; failure → `` `Could not log in to ${database} as ${login}: ${safeErrorMessage(error, password)}` ``; then `insertProject({ ref, name, boxId, dbName: database, ownerRole: login, ownerPasswordEnc: encryptSecret(password), kind: "attached", loginSuperuser })`. No `refreshPooler`, no other SQL.
- `updateProjectLogin`: refuse non-attached with `` `${ref} was created by hattisar; rotate its password instead.` ``; hold the lock (`holdingProject`, update-login operation from Global Constraints); same connect check against `project.dbName`; then `setProjectLogin`.
- `detachProject`: refuse non-attached with `` `${ref} was created by hattisar; delete it instead.` ``; hold the lock (detach operation); `deleteProject(db, id)`; no box access, no `onLifecycle`.
- Guards: `rotateOwnerPassword`, `softDeleteProject`, `restoreProject`, `purgeProject`, `restoreIntoProject` each return `{ ok: false, problem: attachedProblem(project.ref) }` first thing when `isAttached(project)`.

- [ ] **Step 1: Write failing tests** in `projects-attach.test.ts`, using the fake `AdminClientRunner` + in-memory registry pattern of `projects-lifecycle.test.ts`:
  - `attachableDatabases` excludes templates (by query), `_supabase`, a created project's `dbName`, a Trash row's `deletedDbName`; refuses a managed and the shared box with the exact problem.
  - `attachProject` happy path: row has `kind: "attached"`, `dbName` = the chosen database, `ownerRole` = login, `loginSuperuser` from the query, and the fake admin saw **only** the list query and the `select rolsuper …` query (assert the SQL log).
  - The connect runs with `user: login`, `password`, and `database`.
  - Wrong password: problem starts `Could not log in to`, contains `********` not the password, and no row is inserted.
  - A database already used by a created project, sent directly (not via the picker): refused with `Database … cannot be attached`.
  - Duplicate ref: the existing `Ref … is already taken` problem.
  - `updateProjectLogin` swaps login/password/superuser; refused for a created project; refused while a backup row is `running` (busy problem text).
  - `detachProject` removes the row; refused for a created project; `onLifecycle` spy not called; no admin calls.
- [ ] **Step 2: Extend** `projects-lifecycle.test.ts` (rotate, soft delete, restore, purge on an attached row → `attachedProblem`, zero admin calls) and `backups-restore.test.ts` (`restoreIntoProject` on an attached row → `attachedProblem`).
- [ ] **Step 3: Run** `pnpm vitest run test/unit/projects-attach.test.ts test/unit/projects-lifecycle.test.ts test/unit/backups-restore.test.ts` — FAIL.
- [ ] **Step 4: Implement** `src/projects/attach.ts` and the guards.
- [ ] **Step 5: Run** the three files, then `pnpm test` — PASS.
- [ ] **Step 6: Commit** `feat(projects): attach, update login and detach existing databases` (attach.ts + its test), then `feat(projects): refuse lifecycle operations on attached projects` (guards + their tests).

### Task 3: Read paths — Studio, connection strings, sizes, dumps

**Files:**
- Modify: `src/projects/studio-source.ts`, `src/projects/connection-strings.ts`, `src/projects/usage.ts`, `src/backups/service.ts` (`runBackup`), `src/backups/routes.tsx` (dump download)
- Test: `test/unit/projects-connection-strings.test.ts`, `test/unit/studio-content.test.ts` or the existing test that covers `RegistryProjectSource`, create `test/unit/projects-usage.test.ts` if no usage test exists, `test/unit/backups-*.test.ts` covering `runBackup`

**Interfaces:**
- Consumes: Task 1 `kind`; Task 2 `isAttached`, `attachedConnection`.
- Produces: `ownerConnectionStrings(box, project: Pick<Project, "dbName" | "ownerRole" | "kind">, password, poolerHost)`.

- [ ] **Step 1: Write failing tests:**
  - Connection strings for an attached project on a box **with** pooler fields: exactly one string, kind `direct`, user = login verbatim, `?sslmode=` rule unchanged.
  - Same on a `*.pooler.supabase.com` box with login `postgres.abc`: user stays `postgres.abc` (not `postgres.abc.abc`).
  - `RegistryProjectSource.get` for an attached project: `ownerRole` = login verbatim on a Supabase-pooler box; an undecryptable password throws `UnreadableSecretError` whose message ends `Update its login on its hattisar project page.`
  - `projectUsage`: box with one created and one attached project; admin batch query is called with the created `dbName` only; the attached size comes from a connection as the login (`attachedConnection`); when that connection throws, `usage.boxes[id].reachable` is still `true`, the created size is present, the attached ref is absent from `usage.projects`.
  - `runBackup` on an attached project calls `startDump` with `attachedConnection` (user = login), not the box admin.
- [ ] **Step 2: Run** those files — FAIL.
- [ ] **Step 3: Implement.** In `toSummary` and `ownerConnectionStrings`, use the login verbatim and skip pooled strings when attached. In `projectUsage`, partition each box's projects; created ones keep the batch query; each attached one runs `SIZES_SQL` with `[project.dbName]` through `admin(attachedConnection(...), …, project.dbName)` inside its own try/catch. In `runBackup` and the dump route, pick `attachedConnection` when attached (wrap decrypt failure the way `boxCredentials` does: `` `Could not read the login of project ${ref}.` ``).
- [ ] **Step 4: Run** — PASS; `pnpm test`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(projects): read attached projects with their own login`.

### Task 4: UI — attach page, project page, list badge

**Files:**
- Create: `src/ui/pages/attach.tsx`
- Modify: `src/projects/routes.tsx`, `src/ui/pages/projects.tsx`, the boxes page (`src/ui/pages/boxes.tsx` or wherever registered box rows render)
- Test: `test/unit/projects-app.test.ts`

**Interfaces:**
- Consumes: Task 2 service functions; Task 1 `kind`, `loginSuperuser`.
- Produces: routes `GET /_hs/projects/attach[?box=<id>]`, `POST /_hs/projects/attach`, `POST /_hs/projects/:ref/login`, `POST /_hs/projects/:ref/detach`. **Register `/attach` before `/:ref` routes** so it is not read as a ref (and `attach` must not become a valid ref: add it to `refProblem`'s reserved list next to `new`, with a naming test).

- [ ] **Step 1: Write failing tests** in `projects-app.test.ts` (same harness as the existing create tests):
  - `GET /_hs/projects/attach?box=<registered id>` lists the box's attachable databases as `<option>`s; for no `box` it shows a box picker of registered boxes only.
  - `POST /_hs/projects/attach` success → 302 to `/_hs/projects/<ref>`; failure re-renders with the problems and keeps typed values except the password (status 400).
  - Project page of an attached project: shows the `attached` badge, "Login" (not "Owner role"), the superuser warning text `Studio runs as a superuser here and can reach every database on this server.` when `loginSuperuser`, an Update login form instead of Rotate, a Detach card instead of Delete, and no restore-in-place button on the Backups tab (restore into a new project remains).
  - `POST /_hs/projects/:ref/detach` with wrong confirm → 400 and the confirm message; right confirm → 302 to `/_hs/projects`, row gone.
  - `POST /_hs/projects/:ref/login` success → 302 to `/_hs/projects/<ref>?login-updated`; failure → 400 with problem.
  - Connect tab of an attached project whose password will not decrypt points to Update login, not Rotate.
  - Projects list shows the `attached` badge next to the status badge, in both grid and table views.
  - New project page links to `/_hs/projects/attach`; a registered box row on the Boxes page links to `/_hs/projects/attach?box=<id>`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** following the existing JSX components (`ProjectFields`, `KindBadge`, `GeneralTab`, `ConnectTab`). Copy: page title `Attach existing database`; Detach card heading `Detach project`, body `Removes <ref> from hattisar. The database and its data stay on the box.`; Update login card heading `Update login`.
- [ ] **Step 4: Run** — PASS; `pnpm test`, `pnpm lint`.
- [ ] **Step 5: Commit** `feat(ui): attach existing databases and manage attached projects`.

### Task 5: API and CLI

**Files:**
- Modify: `src/api/projects.ts`, `src/api/boxes.ts` (or wherever `GET /boxes` lives), `cli/src/commands/projects.ts`, `cli/src/commands/boxes.ts`
- Test: `test/unit/api-app.test.ts`, `test/unit/cli-commands.test.ts`

**Interfaces:**
- Consumes: Task 2 service functions.
- Produces: §15.4 endpoints exactly as specified; `projectJson` gains `kind`; CLI commands per §15.5.

- [ ] **Step 1: Write failing API tests:**
  - `GET /boxes/:id/databases` → `["a","b"]`; 400 for managed/shared; 404 unknown box; 502 when the box query fails.
  - `POST /projects/attach` → 201 project with `kind: "attached"`; `ref` defaults to `slugify(name)`; 400 with problems on bad login.
  - `PUT /projects/:ref/login` → `{ ok: true }`; 409 for a created project.
  - `POST /projects/:ref/detach` → 400 wrong confirm (message from Global Constraints); 409 for a created project; `{ ok: true }` otherwise.
  - `POST /projects/:ref/rotate`, `DELETE /projects/:ref` on an attached project → 409 with `attachedProblem`, even when not busy.
  - `GET /projects` items include `kind`.
- [ ] **Step 2: Write failing CLI tests:**
  - `projects attach Shop --box 3 --database shop --login app` reads the password from stdin (non-TTY), posts `{ name, ref?, boxId: 3, database, login, password }`, prints the created project; no `--password` option exists (unknown option → exit 2).
  - `projects set-login shop --login app2` reads password from stdin, sends `PUT`.
  - `projects detach shop --confirm shop` → `POST /detach`; mismatched `--confirm` → exit 2 before any request.
  - `boxes databases 3` prints one name per line; `--json` prints the array.
  - `projects list` table gains a `KIND` column.
- [ ] **Step 3: Run** `pnpm vitest run test/unit/api-app.test.ts test/unit/cli-commands.test.ts` — FAIL.
- [ ] **Step 4: Implement.** API: check `isAttached` before rotate/delete/undelete and answer `apiError(c, 409, attachedProblem(ref))`; the attach-only endpoints answer 409 for created projects; for an attached project `UNREADABLE_PASSWORD` reads `The project's password could not be decrypted. Update its login to repair.` CLI: reuse `readSecret(io.stdin, io.stderr, "Password: ")` and `requireConfirm`.
- [ ] **Step 5: Run** — PASS; `pnpm test`, `pnpm build:cli`.
- [ ] **Step 6: Commit** `feat(api): attach, set login and detach endpoints`, then `feat(cli): attach, set-login, detach and boxes databases`.

### Task 6: Integration test and docs

**Files:**
- Create: `test/integration/attached-projects.test.ts`
- Modify: `README.md` (one line under features if a feature list exists), delete this plan file
- Test: the new integration file

- [ ] **Step 1: Write the integration test** against the dev stack's Postgres (follow `test/integration/projects.test.ts` setup): as the box superuser create a throwaway database `it_attach_<random>` owned by a throwaway role `it_attach_<random>` with a password and one table; register a box for it as `registered` (or reuse the suite's registered-box helper); attach it; assert:
  - Studio's pg-meta `GET /tables` through hattisar's `/project/<ref>` path returns the table (as the existing studio-proxy tests do);
  - `pg_database` / `pg_roles` / ownership of the table are byte-identical before and after attach, update login and detach (snapshot `select datname, datdba, datacl from pg_database where datname = $1`, `select rolname, rolsuper, rolcanlogin, rolpassword is not null from pg_authid where rolname = $1`, `select tableowner from pg_tables where schemaname='public'`);
  - a backup (with the suite's S3) dumps as the login and succeeds;
  - after detach the database still exists with its data.
  Clean up the throwaway database and role in `afterAll`.
- [ ] **Step 2: Run** `pnpm test:it -- attached-projects` (needs `pnpm stack:up`) — PASS.
- [ ] **Step 3: Delete** `docs/plans/2026-10-25-attached-projects.md`; check `docs/design.md` §7.1 matches what shipped and fix any drift.
- [ ] **Step 4: Commit** `test(projects): attach an existing database end to end`, then `docs: drop the attached projects plan`.
