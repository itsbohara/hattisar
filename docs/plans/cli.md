# Plan: API tokens, JSON API and the `hattisar` CLI

**Spec:** `docs/design.md` (binding). This plan adds §15 to it in Task 7.
**Scope agreed with the user (2026-10-21):** a JSON API with API tokens plus a CLI for projects,
connection URLs, backups and boxes. Out of scope: orgs, members, full stacks, PocketBase, replicas,
failover, restore-into-new-project, purge, schedules, box registration and editing. Migrations stay
with the official `supabase` CLI via `--db-url`.

## Global constraints

- Every hard invariant in `AGENTS.md` holds. In particular, secrets never go in logs, argv or error
  messages. A token is shown once, stored only as a SHA-256 hash, and never accepted on the command
  line.
- The API calls the **same service functions** the UI routes call (`createProject`,
  `createProjectOnNewBox`, `rotateOwnerPassword`, `softDeleteProject`, `restoreProject`,
  `runBackup`, `restoreIntoProject`). It does not reimplement validation, locking or SQL.
- Project lookup goes through `accessibleProject` / `canAccess`. Unknown, deleted and forbidden
  projects all return 404.
- Match the surrounding code. Comments only for traps, load-bearing negatives and non-local reasons.
- Implementers do not commit. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` locally. **Never**
  run `pnpm test:it`, `pnpm test:e2e`, `pnpm stack:*` or any docker command: the user's dev stack
  is live, and CI runs those.

## Rulings

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| R1 | A token is `hs_` + 32 random bytes (base64url). Stored as `hashToken()` (SHA-256 hex). The table also keeps `prefix` = the first 10 characters, for display. | Same scheme as sessions. 256 bits needs no rate limit. | A new column. |
| R2 | No scopes: a token acts as its user with full rights. | One admin user; `canAccess` is still the per-project seam. | Add a `scopes` column later; old tokens default to full rights. |
| R3 | Expiry is chosen at creation: 30, 90 (default), 365 days or never. An expired token gets 401 and its row is deleted, as sessions are. | Short-lived by default, with no rotation machinery. | UI-only change. |
| R4 | Revoking deletes the row. A password change does **not** revoke tokens. Tokens are listed and revoked separately. | Tokens are explicit credentials, and the page lists them all. | One line in the password route. |
| R5 | `last_used_at` is written on every authenticated API request. | A cheap SQLite update. It shows stale tokens. | Throttle later. |
| R6 | The API lives under `/_hs/api/v1/`. It accepts **only** `Authorization: Bearer <token>` and never the session cookie. Bearer is accepted **nowhere else**: Studio's proxy and the UI ignore it. The same-origin check is skipped for `/_hs/api/v1/*`, because no cookie means no CSRF. | It keeps CSRF and the Studio proxy out of the API's threat model. | Accepting cookies later is additive. |
| R7 | JSON errors use the existing shape `{ "error": { "message": string, "problems"?: string[] } }`. Statuses: 400 bad input (`problems` lists them), 401 missing, unknown or expired token, 404 not found, 409 project busy (`busyReason` is set when the service fails), 502 box or S3 failure, 500 unexpected (the existing `onError`, extended to `/_hs/api/`). | One error shape across `/api` and `/_hs/api`. | Clients branch on status only. |
| R8 | Destructive endpoints (delete, restore a backup) require the body `{"confirm": "<ref>"}`, as the UI's type-the-ref does. The CLI passes it only from `--confirm <ref>`. | A scripted typo can't drop the wrong project. | It is one flag. |
| R9 | The CLI is a separate package in `cli/`, named `hattisar`, with bin `hattisar` and **zero runtime dependencies** (Node ≥ 24: `fetch`, `node:util` `parseArgs`, `node:readline`). It is **not** a pnpm workspace member. The root tsc builds it (`pnpm build:cli`). Publishing to npm is left to the user. | An npm install pulls no server deps (better-sqlite3, dockerode). The Dockerfile and lockfile are unchanged. | Turn it into a workspace later. |
| R10 | CLI config is `$XDG_CONFIG_HOME/hattisar/config.json` (falling back to `~/.config/hattisar/config.json`) holding `{ "url", "token" }`. The directory is 0700 and the file 0600. The env vars `HATTISAR_URL` and `HATTISAR_TOKEN` override it. | Conventional. Env vars are for CI. | A path change. |
| R11 | `hattisar login <url>` reads the token from a hidden TTY prompt, or from stdin when stdin is not a TTY. It checks the token with `GET /me` before saving. There is no `--token` flag. | Secrets never in argv (invariant). | None. |
| R12 | Output is human tables by default; `--json` prints the API's JSON verbatim. Errors go to stderr as `hattisar: <message>` (with `problems` as `  - <problem>` lines). Exit codes: 0 ok, 1 API or network error, 2 usage error, 3 not logged in or 401. | Scriptable and readable. | Additive. |
| R13 | `projects url <ref>` prints exactly one URL with the real password: the first string `ownerConnectionStrings` returns (session pooler on the shared box, direct elsewhere). `--transaction` picks the transaction pooler and fails with exit 1 if the box has none. | Scripts do `$(hattisar projects url x)`. | A flag. |
| R14 | Restore means into the same project only. `projects restore <ref>` means undelete from the trash (the UI's "Restore" in Trash). `backups restore <ref> <id> --confirm <ref>` restores a backup into the project. | Matches the UI's words. | Naming. |

## API surface (all JSON, all under `/_hs/api/v1`)

| Method & path | Body | 2xx response |
|---|---|---|
| `GET /me` | – | `{ "username" }` |
| `GET /boxes` | – | `[{ id, name, kind, devOnly, publicHost, publicPort }]`: never host, admin user or secrets |
| `GET /projects?status=active\|deleted` (default active) | – | `[{ ref, name, status, box: { id, name, kind }, createdAt, deletedAt }]` |
| `POST /projects` | `{ name, ref?, boxId? , newBox? }`. `ref` defaults to `slugify(name)`; `boxId` defaults to the shared box; `newBox: true` needs managed boxes on (else 400) | 201 + the project object as in the list |
| `GET /projects/:ref` | – | project object + `connections: [{ label, kind: "direct"\|"session"\|"transaction", masked }]` |
| `GET /projects/:ref/connections` | – | `[{ label, kind, url }]`: the real password. 502 if the owner secret won't decrypt |
| `POST /projects/:ref/rotate` | – | 200 `{ "ok": true }` |
| `DELETE /projects/:ref` | `{ confirm }` | 200 `{ "ok": true }` (soft delete) |
| `POST /projects/:ref/undelete` | – | 200 the project object (looks up **deleted** projects; 404 if not in trash) |
| `GET /projects/:ref/backups` | – | `[{ id, kind, status, sizeBytes, error, createdAt, finishedAt }]` |
| `POST /projects/:ref/backups` | – | 201 the newest backup row after `runBackup` succeeds |
| `POST /projects/:ref/backups/:id/restore` | `{ confirm }` | 200 `{ "ok": true }`. 404 unless the backup belongs to the project and is `done` |

## CLI surface

```
hattisar login <url>                 hattisar logout              hattisar whoami
hattisar projects list [--deleted]
hattisar projects create <name> [--ref <ref>] [--box <id> | --new-box]
hattisar projects show <ref>
hattisar projects url <ref> [--transaction]
hattisar projects rotate <ref>
hattisar projects delete <ref> --confirm <ref>
hattisar projects restore <ref>
hattisar backups list <ref>
hattisar backups run <ref>
hattisar backups restore <ref> <backup-id> --confirm <ref>
hattisar boxes list
Global: --json, --help, --version
```

### Task 1: Token storage and service

**Files:** `src/registry/migrations/003_api_tokens.sql`, `src/registry/api-tokens.ts`,
`src/auth/api-tokens.ts`, `test/unit/auth-api-tokens.test.ts`.

- Migration: table `api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users (id)
  ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT)` plus an index on `user_id`.
  `expires_at` NULL means it never expires.
- `src/registry/api-tokens.ts`: repository in the style of `registry/sessions.ts`: insert,
  list by user (newest first), get by hash, touch `last_used_at`, delete by `(id, user_id)`.
- `src/auth/api-tokens.ts`:
  - `TOKEN_EXPIRY_DAYS = [30, 90, 365] as const`, default 90; `null` = never.
  - `createApiToken(db, userId, name, expiryDays, now)` returns `{ token, row }`. The name is trimmed,
    1–64 chars. It returns a problem string on invalid input, in the style of the existing
    validators.
  - `resolveApiToken(db, token, now)` returns `{ user, tokenId } | undefined`. It rejects anything
    not starting with `hs_`, deletes expired rows, touches `last_used_at` and reuses `hashToken`
    from `auth/sessions.ts`.
  - `revokeApiToken(db, userId, id)` returns a boolean.
- Tests: create→resolve round trip; a wrong or unprefixed token; expiry deletes the row; "never"
  has no expiry; revoking another user's token id fails; the plaintext token never appears in the
  table (scan every column).

### Task 2: Settings → API tokens page

**Files:** `src/ui/pages/settings.tsx`, `src/auth/routes.tsx`, `src/ui/static/app.css` (only if
needed), `test/unit/settings-app.test.ts`.

- Add a third settings section `API_TOKENS_SETTINGS = "/_hs/settings/tokens"` to the section nav
  after Account, labelled "API tokens".
- GET lists the tokens: name, `prefix…`, created, last used ("never"), expires ("never" or date).
  Each row has a Revoke form (`POST /_hs/settings/tokens/:id/revoke` → 302 back). There is an empty
  state.
- The create form has name and expiry (select: 30 days, 90 days (selected), 1 year, never).
  `POST /_hs/settings/tokens` renders the page with status 201 and a one-time notice holding the
  token in a readonly `<input>` labelled "New token". Its copy says it won't be shown again and
  gives `hattisar login <origin>` as the next step. Invalid input → 400 with the problem.
- Neither the token nor its hash ever appears in a redirect URL or in a log.
- Tests: the section nav marks the page current; create shows the token once (a reload of the GET
  does not contain it); revoke removes it; another user's id → 404; a bad name → 400.

### Task 3: API auth, routing and the read-only endpoints

**Files:** `src/studio/routes.ts`, `src/auth/middleware.ts`, `src/api/auth.ts`,
`src/api/errors.ts`, `src/api/routes.ts`, `src/app.ts`, `test/unit/studio-routes.test.ts`,
`test/unit/api-app.test.ts`.

- The classifier gets `{ kind: "hattisar-api" }` for `/_hs/api` and `/_hs/api/*`, checked before
  the generic `/_hs/` rule. `requireSameOrigin` and `requireSession` both pass `hattisar-api`
  through untouched (R6). Keep the classifier as the single source of truth.
- `src/api/auth.ts`: `requireApiToken(db)` middleware reads the `Authorization: Bearer` header
  (case-insensitive scheme) and calls `resolveApiToken`. On failure it returns 401
  `{ error: { message: "Missing or invalid API token" } }`. On success it sets `c.var.session`'s
  `user` (reuse `AuthEnv`. The API never reads `tokenHash`; pick the smallest type change that
  keeps that honest).
- `src/api/errors.ts`: helpers that build the R7 error bodies and map a service `{ ok: false }` to
  409 or 502 (R7).
- `src/api/routes.ts`: `apiRoutes(deps)` mounted at `/_hs/api/v1`, with `GET /me` and
  `GET /boxes` in this task. An unknown `/_hs/api/*` path → 404 JSON (not the HTML page).
- `app.onError` returns JSON for `/_hs/api/` as well as `/api/`.
- Tests: the cookie alone → 401 on the API; bearer on `/_hs/projects` and on a Studio
  `/api/platform/...` path → treated as unauthenticated (redirect or 401 as today); a cross-origin
  POST with bearer to the API is not 403; expired → 401; `/boxes` has no admin fields (assert the
  keys exactly).

### Task 4: Project endpoints

**Files:** `src/api/routes.ts` (or `src/api/projects.ts` if routes.ts passes ~200 lines),
`test/unit/api-app.test.ts`.

- Implement every `/projects` row of the API table except the backups ones. Read the JSON body
  defensively: a non-object or wrong-type field → 400 with problems.
- `kind` for a connection string comes from its label (`Direct` → direct, `Session pooler` →
  session, `Transaction pooler` → transaction). Export the label constants from
  `connection-strings.ts` rather than matching string literals twice.
- `newBox: true` with managed boxes off → 400 `problems: ["Managed boxes are not enabled."]`.
  `newBox` together with `boxId` → 400.
- Tests reuse the fake admin runner pattern from `projects-app.test.ts`: create (201, and the
  defaulted ref), duplicate ref → 400 with problems, show masks the password, `/connections`
  holds it, rotate, delete without or with the wrong confirm → 400, delete → 200 then GET → 404,
  `?status=deleted` lists it, undelete → 200, busy → 409 (hold the lock with `holdingProject`
  around the request).

### Task 5: Backup endpoints

**Files:** `src/api/routes.ts` or `src/api/backups.ts`, `src/app.ts`, `test/unit/api-app.test.ts`.

- `apiRoutes` now also takes `BackupDeps`. Implement the three backup rows.
- `POST /backups` with S3 not configured → 400 with `NOT_CONFIGURED` as the message (it is a
  settings problem, not a box failure).
- Tests: list shape (no `s3Key` or `bucket` exposed), run without S3 → 400, restore with a wrong
  confirm → 400, a backup of another project → 404, a non-`done` backup → 404. Stub the service
  boundaries as the existing backup tests do. Do not reach S3.

### Task 6: The CLI

**Files:** `cli/package.json`, `cli/tsconfig.json`, `cli/README.md`, `cli/src/*.ts`, root
`package.json` (script `build:cli`), root `tsconfig.json` (`include` adds `cli/src`),
`vitest.config.ts` (unchanged unless needed), `.gitignore` (`cli/dist`), `.github/workflows/ci.yml`
(`check` job runs `pnpm build:cli`), `test/unit/cli-*.test.ts`.

- `cli/package.json`: `name: "hattisar"`, `version: "0.1.0"`, `type: "module"`,
  `bin: { "hattisar": "dist/main.js" }`, `files: ["dist"]`, `engines.node: ">=24"`, license
  Apache-2.0, repository `github:itsbohara/hattisar` (`directory: cli`), **no `dependencies`**.
  `dist/main.js` starts with `#!/usr/bin/env node`.
- Structure (suggested, not binding): `main.ts` (parse, dispatch, exit code), `config.ts` (R10),
  `client.ts` (`fetch` wrapper taking an injectable `fetch`; maps non-2xx to a typed error carrying
  status, message and problems), `commands/*.ts`, `output.ts` (table formatter, `--json`).
- The entry point is testable: export `run(argv, io)` where `io` supplies `fetch`, `stdout`,
  `stderr`, `stdin`, `env` and the config dir, and returns the exit code. `main.ts` is only the
  process glue.
- Behaviour per the CLI surface table and R10–R14. `--help` per command. An unknown command or a
  missing argument → usage on stderr, exit 2. A network error → `hattisar: cannot reach <url>:
  <cause>`, exit 1.
- Tests in `test/unit/cli-*.test.ts` drive `run()` against the **real** `createApp` in process
  (`fetch` = `(req) => app.request(req)`) with a temp registry, the fake admin runner and a token
  created through `createApiToken`. This is the contract test between the CLI and the API. Cover:
  login (piped stdin) writes a 0600 config and a bad token exits 3 without writing; `projects
  create`/`list`/`url`/`delete --confirm`; `--json` output parses; a missing `--confirm` exits 2;
  `HATTISAR_TOKEN` overrides the config; the token never appears in stdout or stderr.

### Task 7: Integration test, docs, plan removal

**Files:** `test/integration/cli.test.ts`, `docs/design.md`, `README.md`, `TASK.md`,
`docs/plans/cli.md` (delete).

- Integration (CI only, against the real stack, following the existing integration helpers):
  sign in, create a token via `POST /_hs/settings/tokens` (parse it from the page), run the CLI's
  `run()` with the real `fetch`: `projects create`, `projects url`, connect with `pg` using that
  URL and `select 1`, `projects delete --confirm`, then revoke the token and expect exit 3.
- `docs/design.md`: new **§15 API and CLI** describing R1–R14, the API table and the CLI surface.
  §6 gets one bullet pointing at API tokens. §2/§9 get a line each where the layout or UI is listed.
- `README.md`: a CLI section (install from source: `pnpm build:cli`, `node cli/dist/main.js`; once
  published, `npx hattisar`), plus migrations with the official CLI:
  `supabase db push --db-url "$(hattisar projects url <ref>)"`.
- `TASK.md` rulings header gains this PR once its number is known. **Delete this plan file** in
  the same change.
