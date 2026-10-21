# hattisar — design (authoritative spec)

Multi-project databases for self-hosted Supabase Studio. A *project* is a Postgres database on a
*box*. One stock, unmodified Studio serves every project; hattisar sits in front of it.

Origin: `~/code/ideastorm/concepts/hattisar/README.md` (decisions Q1–Q17, grilled 2026-10-20).
Where that file and this one disagree, **this one is right**.

---

## 1. How Studio reaches a database (the fact the design rests on)

Studio image `supabase/studio:2026.10.12-sha-3699278`, read from `apps/studio` source:

| Studio route | How it picks the DB |
|---|---|
| `POST /api/platform/pg-meta/<ref>/query` | Builds a connection string from **its own env** (`lib/api/self-hosted/util.ts`), encrypts it, sends `x-connection-encrypted` to postgres-meta `POST /query` with body `{query, parameters?}`. `<ref>` ignored. |
| `/api/platform/pg-meta/<ref>/{tables,policies,triggers,extensions,publications,types}` | **Relays** the incoming `x-connection-encrypted` header to postgres-meta (`lib/api/apiHelpers.ts` `constructHeaders`). Header absent → postgres-meta uses its own default DB. |
| `/api/ai/code/complete`, `/api/ai/sql/generate-v4` | Build the connection from env. Need an OpenAI key. |
| `GET /api/platform/projects`, `GET /api/platform/projects/<ref>` | Return one hard-coded `DEFAULT_PROJECT`, whatever the ref. |
| `/api/platform/projects/<ref>/run-lints`, `/api/v1/projects/<ref>/database/migrations`, `/api/mcp*` | Query through Studio's env connection (`lib/api/self-hosted/{lints,migrations,mcp}.ts` → `executeQuery`). Not redirectable. |
| `/api/v1/projects/<ref>/types/typescript` | `GET ${PG_META_URL}/generators/typescript?...` **without** a connection header → meta's default DB. |
| `/api/platform/projects/<ref>/databases` | Returns hard-coded connection info for `postgres`. |
| `GET /api/platform/projects/<ref>/settings` | Returns one hard-coded project (`lib/api/self-hosted/settings.ts` `getProjectSettings`): flat `db_host`/`db_port` from env, `db_name`/`db_user` = `postgres`, `ssl_enforced: false`, plus `ref`, `service_api_keys`, `jwt_secret`, `app_config`. |

**Fail closed.** Studio's `POSTGRES_DB` and meta's `PG_META_DB_NAME` are set to
`hattisar_no_project`, a database that exists on no box. Any route hattisar does not redirect —
including ones a future Studio adds — errors instead of reading another project's data.

Encryption: `crypto-js` `AES.encrypt(connectionString, PG_META_CRYPTO_KEY).toString()` (passphrase
mode, OpenSSL-compatible output). postgres-meta decrypts with the same key.

## 2. Architecture

```
browser ──► hattisar :8000 ──► studio:3000 (internal only)
              │                     │
              │                     └──► meta:8080 ──► box (any registered Postgres)
              ├─► meta:8080  (hattisar's own /query handling)
              ├─► boxes      (admin ops: create db/role, dumps)
              ├─► S3         (backups)
              └─► docker-socket-proxy (only when managed boxes are on)
apps ──► supavisor :54322/:6543 ──► shared box     |   apps ──► other boxes directly
```

Lean stack (`docker/compose.yml`, compose project `hattisar`): `db` (supabase/postgres),
`meta`, `studio`, `supavisor`, `hattisar`; `docker-proxy` only under profile `managed-boxes`.
Image versions are pinned to one official self-hosted release (§12). Studio, meta and db publish
no host ports. hattisar always runs inside the compose network (also in dev), so a box has one
internal address valid for both hattisar and meta.

## 3. Request handling in front of Studio

Order matters; first match wins.

| Path | Behaviour |
|---|---|
| `/_hs/healthz` | 200 `{"ok":true}`, no auth. |
| `/_hs/login`, `/_hs/static/*` | No auth. |
| everything else | Requires a session (§6). API paths (`/api/*`) → 401 JSON; pages → 302 `/_hs/login`. |
| `/` | 302 `/_hs/projects` |
| `/_hs/*` | hattisar's own UI and actions. |
| `/api/ai/*` | 404 `{"error":{"message":"AI features are disabled in hattisar"}}` |
| `GET /api/platform/projects` | Active projects the user may access, Studio shape (§3.1). |
| `GET /api/platform/projects/:ref` | One project, Studio shape + `connectionString: ""`, `restUrl: ""`. Unknown/deleted/forbidden → 404. |
| `GET /api/platform/projects/:ref/run-lints` | 200 `[]` — any error status makes Studio retry with backoff for ~12 s before the Table Editor refreshes (measured). Advisors therefore show no lints. |
| `/api/v1/projects/:ref/database/migrations`, `/api/mcp`, `/api/mcp/*` | 404 `{"error":{"message":"Not available in hattisar"}}` |
| `GET /api/platform/projects/:ref/databases` | hattisar answers: Studio's shape with `identifier` = ref, `db_name`, `db_host`/`db_port` = box public host/port, `db_user` = the project's owner role (admin user until projects have owners), other fields as Studio's. |
| `GET /api/platform/projects/:ref/settings` | hattisar fetches Studio's stub for the same request and overrides only `ref`, `name`, `db_host`/`db_port` (box public host/port), `db_name`, `db_user` (owner role) and, when the box's sslmode is `require`/`verify-ca`/`verify-full`, `ssl_enforced: true`; every other field is Studio's. Stub unreachable, non-2xx or not a JSON object → 502, never the default. Unknown/deleted/forbidden → 404. |
| `GET /api/v1/projects/:ref/types/typescript` | hattisar calls `${PG_META_URL}/generators/typescript` with the same query Studio uses and the project's `x-connection-encrypted`; mirrors Studio's response shape. |
| `/api/platform/projects/:ref/*` | Unknown/forbidden ref → 404; else pass through. |
| `/api/v1/projects/:ref/*` | Unknown/forbidden ref → 404; else pass through. |
| `POST /api/platform/pg-meta/:ref/query` | hattisar handles it itself (§3.2). |
| `/api/platform/pg-meta/:ref/*` (other) | Unknown/forbidden ref → 404. Else **strip** any client `x-connection-encrypted`, **set** it to the project's encrypted connection string, pass through to Studio. |
| `/project/default`, `/project/default/*` | If no project has ref `default`: 302 `/_hs/projects`. Studio's logo reaches it by client-side navigation, so `studio.js` reloads the page when Studio navigates into it from another ref, letting this rule apply. |
| `/project/:ref`, `/project/:ref/*` | Unknown/forbidden ref → 302 `/_hs/projects`; else pass through. |
| `/projects`, `/organizations`, `/org/*` | 302 `/_hs/projects` |
| `/new`, `/new/*` | 302 `/_hs/projects/new` |
| path starting with `//` | 404. |
| anything else | Pass through to Studio, streaming, method/body/query preserved, `Host` rewritten. The upstream URL is always Studio's origin with the request path set on it — never a URL resolved from the request path. `hs_session` and any client `x-connection-encrypted` are stripped from what Studio receives. |

**Invariant — no silent default DB.** No request reaches postgres-meta (directly or via Studio's
pg-meta routes) without hattisar having set `x-connection-encrypted` for the ref in the URL. A
pg-meta request hattisar cannot resolve is a 404, never a pass-through.

HTML responses from Studio get `<link rel="stylesheet" href="/_hs/static/studio.css">` and
`<script src="/_hs/static/studio.js" defer></script>` injected before `</head>`. The CSS hides
sidebar entries for Authentication, Storage, Edge Functions and Realtime; the script adds a
"← hattisar" link to the top bar and redirects the Connect sheet (below). Content-Length is dropped
on rewritten responses.

Studio's Connect sheet is replaced by hattisar's project page. In self-hosted mode the sheet's
connection strings come from `buildConnectionStringPooler` in the browser bundle, which takes only
`db_host` and `db_port` (from `/databases`) and hard-codes the rest: user `postgres` (pooler tabs
`postgres.[POOLER_TENANT_ID]`), database `postgres`, transaction port `6543`. The Supavisor config
query that feeds the pooler tabs in cloud (`/platform/projects/{ref}/config/supavisor`) is gated on
`IS_PLATFORM` and never sent, so no route hattisar answers can correct the sheet. Instead
`studio.js` watches for Studio's `showConnect=true` query parameter on `/project/<ref>/*` — on page
load, on `popstate`, and by wrapping `history.pushState`/`replaceState`, which is how Studio opens
the sheet without a reload — drops `showConnect`, `connectTab` and `method` from the current
history entry (so Back does not redirect again) and goes to `/_hs/projects/<ref>`, whose connection
strings are the project's own. This relies on Studio opening the sheet through `showConnect`.

### 3.1 Studio project shape

```
{ id: <int>, ref: <slug>, name: <display name>, organization_id: 1,
  cloud_provider: "localhost", status: "ACTIVE_HEALTHY", region: <box name>,
  inserted_at: <ISO-8601> }
```

### 3.2 hattisar's `/query`

Read JSON body `{query, parameters?}`. Build the project's **Studio connection string**
`postgresql://<owner role>:<owner pw>@<box host>:<box port>/<db_name>` (URL-encode user and
password; append `?sslmode=<box sslmode>` unless it is `disable`), encrypt (§1), `POST ${PG_META_URL}/query` with headers `Content-Type:
application/json`, `x-connection-encrypted`, body `{query}` plus `parameters` only if present.
Response mirroring, same as Studio: pg-meta OK → 200 with its JSON; pg-meta error → its status with
`{message, formattedError}` (fallback `formattedError = message`); network/parse failure → 500
`{message, formattedError: message}`.

## 4. Registry (SQLite, `better-sqlite3`, file `${HATTISAR_DATA_DIR}/hattisar.db`)

Numbered migrations in `src/registry/migrations/`, applied at boot, tracked in
`schema_migrations`. WAL mode. Tables (names are binding; columns may gain indexes):

- `users(id, username UNIQUE, password_hash, created_at, updated_at)`
- `sessions(token_hash PK, user_id, created_at, expires_at)`
- `boxes(id, name UNIQUE, kind CHECK in ('shared','registered','managed'), dev_only INT,
  host, port, admin_user, admin_password_enc, sslmode, public_host, public_port,
  pooler_tenant NULL, pooler_session_port NULL, pooler_transaction_port NULL,
  container_name NULL, created_at)`
- `projects(id, ref UNIQUE, name, box_id → boxes, db_name, owner_role,
  owner_password_enc, status CHECK in ('active','deleted'), deleted_at NULL,
  deleted_db_name NULL, created_at)`
- `settings(key PK, value)` — S3 config lives here; secret fields encrypted.
- `backup_schedules(project_id PK, frequency CHECK in ('off','daily','weekly'),
  keep_daily, keep_weekly)`
- `backups(id, project_id, kind CHECK in ('manual','scheduled'), s3_key, size_bytes,
  status CHECK in ('running','done','failed'), error NULL, created_at, finished_at NULL,
  bucket)` — `bucket` (migration 002) is where the object was written; delete/restore/retention use it.

### Secrets at rest
AES-256-GCM. Key = SHA-256 of `HATTISAR_SECRET_KEY` (required, ≥ 32 chars, boot fails otherwise).
Stored as `v1:<iv b64>:<tag b64>:<ciphertext b64>`, 12-byte random IV. Every `*_enc` column and
the S3 secret key use it. Plaintext secrets never appear in logs or error messages.
Owner passwords are decrypted only when one project's connection is built, never for a list: a
project whose secret will not decrypt (corrupt, or `HATTISAR_SECRET_KEY` changed) still appears in
Studio's list and answers its routes that need no connection, while its pg-meta and type requests
answer 500 `{message}` saying the password cannot be decrypted. Its hattisar page renders with the
connection strings replaced by that explanation. Rotating repairs a corrupt owner secret. After a
`HATTISAR_SECRET_KEY` change, projects on non-shared boxes cannot rotate until the box's own
credentials are re-entered, because only the shared box is re-seeded from env at boot.

## 5. Boxes

- **shared** — seeded on first boot from env: the compose `db` service, `admin_user =
  supabase_admin`, password `POSTGRES_PASSWORD`, `dev_only = 1`, pooler fields from
  `POOLER_TENANT_ID` and the pooler ports, `public_host = HATTISAR_PUBLIC_HOST`. Exactly one.
- **registered** — added in the UI: name, host, port, admin user/password, sslmode, public
  host/port, `dev_only` checkbox.
- **managed** — started by hattisar (§10).

**E1 compatibility check** (on register, and before creating a managed box's first project),
connecting as the admin: `server_version_num ≥ 150000`; roles `supabase_admin`, `anon`,
`authenticated`, `service_role` exist; extensions `pgcrypto`, `uuid-ossp`, `pg_stat_statements`
are in `pg_available_extensions`; admin is superuser (the H2 baseline needs it for
`pg_stat_statements` and `ALTER SCHEMA public OWNER`).
Failure lists every unmet item. A box with projects (any status) cannot be removed.

## 6. Auth (F3)

- One admin user. First boot with no users: create `HATTISAR_ADMIN_USERNAME` (default `admin`)
  with `HATTISAR_ADMIN_PASSWORD` (required on first boot, ≥ 12 chars). Afterwards the env
  password is ignored.
- Password hash: `scrypt` from `node:crypto`, format `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`,
  N=2^15, r=8, p=1, 16-byte salt, 64-byte key; constant-time compare.
- Session: 32 random bytes, base64url, cookie `hs_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Secure` when `HATTISAR_COOKIE_SECURE=true`), stored as SHA-256 hash, 7-day expiry.
- Every state-changing request (non-GET/HEAD) — `/_hs/*` **and** the proxied `/api/*`, which can
  run SQL — requires `Origin` or `Referer` to match the request host, else 403. The reverse proxy in
  front of hattisar must preserve `Host`.
- Login: 5 failures per username per 15 min → 429 until window passes (in-memory).
- Change password (Settings): current + new (≥ 12) + confirm; on success all other sessions of
  that user are deleted.
- `canAccess(user, project)` is the single authorization seam; every project-scoped path calls it.
  v1 returns `true`.

## 7. Projects

**Ref (P1):** `^[a-z][a-z0-9-]{2,39}$`, immutable. `db_name` = ref with `-` → `_`.
`owner_role` = `hs_<db_name>_owner`. A ref is unavailable if any registry row (active or deleted)
has it, or `db_name` exists on the target box. Display name is editable.

**Create** (as box admin; every identifier/literal built with `format('%I' / '%L')` or the `pg`
escape helpers, never string concatenation):
1. `CREATE ROLE <owner> LOGIN PASSWORD <32-byte random, base64url>`
2. `CREATE DATABASE <db> OWNER <owner>`
3. `REVOKE CONNECT, TEMPORARY ON DATABASE <db> FROM PUBLIC`; `GRANT CONNECT ON DATABASE <db> TO <owner>`
4. In `<db>`: run `sql/baseline.sql` with the owner substituted (H2): `extensions` schema;
   `pgcrypto`, `uuid-ossp`, `pg_stat_statements` in it; `public` owned by owner; `USAGE` on
   `extensions` to owner; `ALTER DATABASE <db> SET search_path = "$user", public, extensions`.
   Anything the shared box's pooler needs for the owner role to authenticate (verified in
   implementation) also goes here.
5. Insert registry row.
Any failure → drop what was created (db, role), no registry row, error shown.

**Isolation (I1):** the owner role cannot connect to any other project's database.

**Studio connects as the owner role**, the same role apps use (as on Supabase Cloud, where Studio
and apps share `postgres`). Every pg-meta connection hattisar builds — its own `/query`, the
relay header, `types/typescript` — uses the owner. If Studio used the box admin, tables created in
Studio would be owned by `supabase_admin` and the app's role would get `permission denied`
(verified). Consequence: Studio actions that need superuser (non-trusted extensions, role
management) fail with a permission error; hattisar's own admin operations still use the box admin.

**Connection strings (J1)** on the project page, password masked with reveal + copy:
- box with pooler fields: session `postgresql://<owner>.<tenant>:<pw>@<public_host>:<session_port>/<db>`
  and transaction (same, `<transaction_port>`).
- other boxes: `postgresql://<owner>:<pw>@<public_host>:<public_port>/<db>`.
- shared/dev-only boxes show a "development only" badge.

**Rotate owner password:** `ALTER ROLE … PASSWORD …`, store encrypted, show new strings. Never
reads the old password, so it works when the stored one will not decrypt.

**Soft delete (M2)** — confirm by typing the ref: `REVOKE CONNECT … FROM <owner>`; terminate
backends on the db; `ALTER DATABASE <db> RENAME TO <db>__deleted_<YYYYMMDD>` (suffix `_2`, `_3`…
on collision); status `deleted`, `deleted_at`, `deleted_db_name`. Hidden from Studio and the
project list; shown under Trash.

The owner role **keeps LOGIN**. Apps still running against a deleted project then pass pooler
authentication and fail on `CONNECT`, instead of failing authentication — Supavisor counts auth
failures per tenant/IP and would otherwise lock out every project on the shared box. Revoked
`CONNECT` on its only database is what stops the role.

Known limitation (shared box): every role can connect to the box's `postgres`, `_supabase` and
`template1` databases because Postgres grants `CONNECT` on them to `PUBLIC`; owner roles cannot
create anything there. Production projects belong on dedicated boxes.
**Restore:** reverse every step. **Purge:** on demand from Trash or automatically after
`HATTISAR_PURGE_AFTER_DAYS` (default 7, checked hourly): `DROP DATABASE … WITH (FORCE)`, `DROP
ROLE`, delete registry rows (backups in S3 are kept; retention never touches a purged project's
objects). Managed boxes: §10.

**One lifecycle operation at a time per project.** Soft delete, restore from Trash, purge (manual
and hourly), password rotation and both kinds of backup restore (§8; for a new project, the restore
step) hold the project for their whole run in an in-process lock — sufficient because hattisar is
one process over one SQLite registry. Any of these, or a manual or scheduled backup, started while
another holds the project or a backup of it is running is refused at once, naming what holds it
("Can't delete <ref> while it is being restored. Try again when it finishes."); nothing waits.
Once it holds the lock an operation re-reads the project and refuses if its status no longer
allows it, e.g. a restore into a project that was deleted meanwhile. The hourly purge skips a busy
project and retries next hour.

## 8. Backups

`pg_dump`/`pg_restore` from `HATTISAR_PG_BIN_DIR` (image ships PostgreSQL 17 client). Passwords
go in `PGPASSWORD` env, never argv. Dumps are custom format (`-Fc`), connecting as box admin.

- **Download (N2):** `GET /_hs/projects/:ref/dump` streams `pg_dump -Fc` as
  `<ref>-<UTC yyyymmddThhmmssZ>.dump`. Non-zero exit after headers sent → connection aborted, error
  logged.
- **S3 settings:** endpoint (optional, for S3-compatible), region, bucket, access key id, secret
  (encrypted), force path style, key prefix (default `hattisar`). "Test connection" = put then
  delete `<prefix>/.hattisar-test`.
- **Manual backup:** "Back up now" streams `pg_dump` into a multipart upload at
  `<prefix>/<ref>/<UTC yyyymmddThhmmssZ>-manual.dump`; row in `backups`.
- **Schedules:** per project `off|daily|weekly`, default off; `keep_daily` 7, `keep_weekly` 4.
  In-process scheduler, ticks every minute; daily runs at `HATTISAR_BACKUP_HOUR_UTC` (default 2),
  weekly on Mondays at that hour; a run is due if no `scheduled` backup with status `done` exists
  for the current period. One backup at a time per project.
- **Retention** (after each successful scheduled run, scheduled backups only): keep the newest
  `keep_daily`; of the rest keep the newest per ISO week, up to `keep_weekly` weeks; delete the
  others from S3 and the table. Manual backups are kept until deleted by hand.
- **Restore:** from a backup into (a) the same project — confirm by typing the ref; terminate
  backends, drop and recreate the database with the §7 steps 2–4 (same owner, same password), then
  `pg_restore --no-owner --no-privileges --role=<owner> -d <db>`; or (b) a new project — the full
  §7 create flow, then the same restore. A failed restore leaves the error on the page. Leftover `restore-*` work directories are
  removed at boot.
- Docs state plainly: dumps restore to the last dump, not a point in time; production boxes also
  need box-level PITR (WAL-G / pgBackRest).

## 9. UI

Server-rendered Hono JSX, one stylesheet, no client framework; tiny inline scripts only for copy /
reveal. Dark by default, respects `prefers-color-scheme`. Pages: Login, Projects (list, "Open in
Studio" → `/project/<ref>/editor`), New project (name, ref with live slug hint, box picker — each
option labelled; dev-only boxes carry the warning "Best for development only — shares one Postgres
with other projects"), Project detail (connection strings, rotate password, download dump, backups
list + schedule + back up now + restore, delete), Trash, Boxes (list, register, edit, remove,
"New managed box" when enabled), Settings. Errors render inline, never as a stack trace.

Settings has a section nav: `/_hs/settings` → 302 `/_hs/settings/storage`. Account
(`/_hs/settings/account`) shows the signed-in username and the change-password form, posting to
`/_hs/settings/password`. Backup storage (`/_hs/settings/storage`) shows whether S3 is configured
(bucket, endpoint host) above the S3 form, which posts to `/_hs/settings/s3` and, for "Test
connection", `/_hs/settings/s3/test`. Each POST re-renders the section it belongs to.

Known limitation: Studio stores SQL snippets in one folder (`SNIPPETS_MANAGEMENT_FOLDER`, a named
volume) regardless of project, so saved snippets appear in every project's SQL editor and run
against whichever project is open. Acceptable for a single admin; scoping
`/api/platform/projects/:ref/content*` per project is post-v1.

## 10. Managed boxes (O4 + O2)

Off unless `HATTISAR_MANAGED_BOXES=true`. Then compose profile `managed-boxes` runs
`docker-proxy` (tecnativa/docker-socket-proxy) with `CONTAINERS=1 IMAGES=1 VOLUMES=1 NETWORKS=1
POST=1` and everything else (EXEC, BUILD, SWARM, …) off; hattisar talks to `DOCKER_HOST` only.

Create: name (`^[a-z][a-z0-9-]{2,39}$`), image = the pinned `supabase/postgres`, random admin
password, volume `hattisar_box_<name>`, container `hattisar-box-<name>` on the compose network,
host port = first free in `HATTISAR_MANAGED_PORT_RANGE` (default `55000-55999`), labels
`hattisar.managed=true`, `hattisar.box=<name>`. Wait until ready, run E1, register as kind
`managed` (`host` = container name, `port` 5432, `public_host` = `HATTISAR_PUBLIC_HOST`,
`public_port` = the host port). The New-project form offers "New dedicated box" which does this
then creates the project on it.

Implementation notes (Task 12): the proxy sits on its own internal `docker-api` network that only
hattisar joins. Two read-only calls are unfiltered by label — listing containers to learn which host
ports are published, and listing networks. Purging the last project on a managed box skips the DROP
SQL and removes the container and volume (`purging` lifecycle event). "New dedicated box" names the
box after the project ref. Known limitations: the box admin password is in the container env
(visible to anyone with Docker access); Postgres's encryption root key lives in the container, not
the volume, so recreating a container by hand (e.g. an image upgrade) loses Vault-encrypted data —
upgrading managed boxes is post-v1.

hattisar only lists/starts/stops/removes containers and volumes carrying `hattisar.managed=true`;
every Docker call filters on it. A managed box whose only project is soft-deleted is stopped;
restore starts it; purge removes container and volume. Removing a managed box with no projects
removes container and volume.

## 11. Configuration

| Env | Default | Notes |
|---|---|---|
| `HATTISAR_SECRET_KEY` | — | required, ≥ 32 chars |
| `HATTISAR_ADMIN_USERNAME` | `admin` | first boot only |
| `HATTISAR_ADMIN_PASSWORD` | — | required on first boot, ≥ 12 chars |
| `HATTISAR_PUBLIC_HOST` | `localhost` | host in connection strings |
| `HATTISAR_PORT` | `8000` | published port |
| `HATTISAR_DATA_DIR` | `/data` | SQLite + temp |
| `HATTISAR_COOKIE_SECURE` | `false` | |
| `HATTISAR_PURGE_AFTER_DAYS` | `7` | |
| `HATTISAR_BACKUP_HOUR_UTC` | `2` | |
| `HATTISAR_PG_BIN_DIR` | `/usr/bin` | |
| `HATTISAR_MANAGED_BOXES` | `false` | |
| `HATTISAR_MANAGED_PORT_RANGE` | `55000-55999` | |
| `DOCKER_HOST` | `tcp://docker-proxy:2375` | managed boxes only |
| `STUDIO_URL` | `http://studio:3000` | |
| `PG_META_URL` | `http://meta:8080` | |
| `PG_META_CRYPTO_KEY` | — | shared with meta |
| `HATTISAR_PG_META_TIMEOUT_SECONDS` | `120` | hattisar's own `/query` and `/generators/typescript` calls; 504 when exceeded; the timeout only stops hattisar waiting, postgres-meta keeps running the statement until its own query timeout |
| `POSTGRES_PASSWORD` | — | shared box admin |
| `POOLER_TENANT_ID`, `POOLER_PORT_SESSION` (54322), `POOLER_PORT_TRANSACTION` (6543) | | shared box pooler |
| `POOLER_SECRET_KEY_BASE`, `POOLER_VAULT_ENC_KEY`, `POOLER_JWT_SECRET` | — | Supavisor's own secrets; generated by `scripts/dev-env.sh` |

`HATTISAR_PORT` is the host-published port only; the app listens on 8000 inside the container.
`DOCKER_HOST` is set explicitly in compose for the `managed-boxes` profile, never inherited from
the host shell.

## 12. Pinned images (official self-hosted, supabase `master` 4b5b2a3, 2026-10-20)

`supabase/studio:2026.10.12-sha-3699278` · `supabase/postgres-meta:v0.100.0` ·
`supabase/postgres:17.6.1.136` · `supabase/supavisor:2.9.13`. Bumping any of them requires the
routing e2e (§13) to pass.

## 13. Testing

- **Unit** (vitest): pure logic — crypto compatibility, secrets, password hashing, slug rules,
  connection strings, retention selection, route classification.
- **Integration** (vitest, `HATTISAR_IT=1`): against the running compose stack through
  hattisar's HTTP surface and the pooler port.
- **E2E** (Playwright, Chromium) against the stack. The **routing test** is permanent: two projects
  on one box with different tables; for project B, open every Studio screen in the list in
  `e2e/studio-screens.ts`, record every `/api/platform/pg-meta/**` request, and assert (a) each
  was served for B's database (hattisar logs the resolved db per pg-meta request at debug and
  exposes the last N in `/_hs/debug/pg-meta-log` only when `HATTISAR_DEBUG=true`), (b) B's table is
  visible and A's is not.
- **CI** (GitHub Actions): lint + typecheck + unit; then integration + e2e with the stack and an
  S3-compatible service.

## 14. Out of v1

Plain-Postgres boxes (E3); multi-user (F2); pooler for non-shared boxes (J3); add-on mode for the
full official stack (K1); point-in-time recovery; boxes on other Docker hosts (O3); Auth/REST/
Storage per project.
