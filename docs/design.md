# hattisar — design (authoritative spec)

Multi-project databases for self-hosted Supabase Studio. A *project* is a Postgres database on a
*box*. One stock, unmodified Studio serves every project; hattisar sits in front of it.

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
              ├─► supavisor:4000 (tenant API, §5.1)
              └─► docker-socket-proxy (only when managed boxes are on)
apps ──► supavisor :54322/:6543 ──► boxes with a pooler tenant (§5.1)
apps ──► box public host/port   ──► any non-shared box directly
```

Lean stack (`docker/compose.yml`, compose project `hattisar`): `db` (supabase/postgres),
`meta`, `studio`, `supavisor`, `hattisar`; `docker-proxy` only under profile `managed-boxes`.
Image versions are pinned to one official self-hosted release (§12). Studio, meta and db publish
no host ports. hattisar always runs inside the compose network (also in dev), so a box has one
internal address valid for both hattisar and meta.

Besides the proxy and UI, hattisar serves a JSON API under `/_hs/api/v1` (`src/api/`) for the
`hattisar` CLI, a separate zero-dependency package in `cli/` (§15).

## 3. Request handling in front of Studio

Order matters; first match wins.

| Path | Behaviour |
|---|---|
| `/_hs/healthz` | 200 `{"ok":true}`, no auth. |
| `/_hs/login`, `/_hs/static/*` | No auth. Static assets are sent with `Cache-Control: no-cache`, so browsers revalidate them after a restart or upgrade. |
| `/_hs/api`, `/_hs/api/*` | The token API (§15): no session, no `Origin` check; a bearer token instead. |
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
| `/api/platform/projects/:ref/content`, `/api/platform/projects/:ref/content/*` | hattisar's snippet store (§3.3), never Studio. Unknown/deleted/forbidden ref → 404; a method or sub-path §3.3 does not list → 404. |
| `/api/platform/projects/:ref/*` | Unknown/forbidden ref → 404; else pass through. |
| `/api/v1/projects/:ref/*` | Unknown/forbidden ref → 404; else pass through. |
| `POST /api/platform/pg-meta/:ref/query` | hattisar handles it itself (§3.2). |
| `/api/platform/pg-meta/:ref/*` (other) | Unknown/forbidden ref → 404. Else **strip** any client `x-connection-encrypted`, **set** it to the project's encrypted connection string, pass through to Studio. |
| `/project/default`, `/project/default/*` | If no project has ref `default`: 302 `/_hs/projects`. Studio's logo reaches it by client-side navigation, so `studio.js` reloads the page whenever Studio navigates into a different ref than the last project it showed, or into `default`, letting this rule apply (and keeping Studio's in-memory snippets, keyed by id alone, from mixing projects, §3.3). |
| `/project/:ref`, `/project/:ref/*` | Unknown/forbidden ref → 302 `/_hs/projects`; else pass through. |
| `/projects`, `/organizations`, `/org/*` | 302 `/_hs/projects` |
| `/new`, `/new/*` | 302 `/_hs/projects/new` |
| path starting with `//` | 404. |
| anything else | Pass through to Studio, streaming, method/body/query preserved, `Host` rewritten. The upstream URL is always Studio's origin with the request path set on it — never a URL resolved from the request path. `hs_session`, any client `x-connection-encrypted` and an `Authorization: Bearer hs_…` header are stripped from what Studio receives. |

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
strings are the project's own. If Back then restores the Studio page from the back/forward cache,
with the sheet Studio had already opened, `studio.js` reloads it. This relies on Studio opening
the sheet through `showConnect`.

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

### 3.3 SQL snippets

Studio's own snippet store is one folder for every project, and its handlers never read the ref,
so hattisar answers the SQL editor's content API itself, from the registry, scoped by the ref in
the URL. Studio's `SNIPPETS_MANAGEMENT_FOLDER` stays set but is never reached.

| Method and path (under `/api/platform/projects/:ref/`) | Behaviour (Studio's self-hosted wire contract) |
|---|---|
| `GET content` | `{data: Snippet[], cursor?}`. Query `name` (case-insensitive substring, all folders; without it, root snippets only), `limit` (default 100, 1–1000, else 400 `{data:[]}`), `cursor` (id of the previous page's last item), `sort_by` `name`\|`inserted_at` (default `inserted_at`), `sort_order` `asc`\|`desc` (default `desc`). `visibility=project` → `{data:[]}`. `type` and `favorite` are ignored. |
| `PUT content` | Upsert by `id`: `name`, `content.sql`, `folder_id`. A new snippet is validated (400 `{error}`); a name already used in the target folder → 409 `{error}`. Returns the Snippet. Body ≤ 5 MB. |
| `DELETE content?ids=a,b` | 200 `[{id}]`; missing or non-uuid ids → 400 `{error:"Snippet IDs are required"}`. |
| `GET content/item/:id` | The Snippet, or 404 `{message:"Content not found."}`. |
| `GET content/count` | With `name`: `{count}`; else `{shared:0, favorites:0, private:<all>}`. |
| `GET content/folders` | `{data:{folders, contents}, cursor?}`: root folders and root snippets without content, same query as `GET content`. |
| `POST content/folders` | Body `{name}` → 201 Folder; a duplicate name → 409 `{error}`. |
| `DELETE content/folders?ids=a,b` | Deletes the folders and their snippets → 200 `{}`; missing ids → 400 `{error:"Folder IDs are required"}`. |
| `GET content/folders/:id` | `{data:{folders:[], contents}, cursor?}` for that folder. |
| `PATCH content/folders/:id` | Body `{name}`: renames the folder (Studio's own handler ignores it) → 200 `{}`. |

Where Studio's own handler would answer 500, or does nothing, hattisar answers 413 `{error}` for a
body over 5 MB; 400 `{error}` for an invalid body or an unknown folder; `PATCH content/folders/:id`
404 for an unknown folder and 409 for a taken name. `DELETE content` returns the ids it actually
deleted. A new snippet is stored under the id derived from its folder and name, whatever id the body
carries.

Shapes are Studio's: a Snippet is `{id, inserted_at, updated_at, type:"sql", name,
description:"", favorite:false, visibility:"user", project_id:1, folder_id, owner_id:1, owner,
updated_by, content:{sql, content_id, schema_version:"1.0"}}`, a Folder `{id, name, owner_id:1,
parent_id:null, project_id:1}`. Folders are one level deep. Ids follow Studio's
`generateDeterministicUuid` (a snippet from `[folder_id, name + ".sql"]`, a folder from `[name]`),
which the browser also computes before saving, so renaming or moving a snippet changes its id and
the same name has the same id in every project: the registry keys snippets and folders by
(project, id). Names are non-empty, without `/` or NUL. `inserted_at` survives edits.

Snippets live in the registry tables `snippet_folders` and `snippets`, which reference the project
with `ON DELETE CASCADE`: a deleted project's snippets 404 with its ref and come back on restore,
purge removes them, and they are backed up with `hattisar-data`. They are not in a project's
`pg_dump`.

**Import of Studio's shared folder.** Snippets saved before this release carry no project. On the
first boot with snippet support, hattisar reads the `studio-snippets` volume (mounted read-only at
`/studio-snippets`) and copies every snippet and folder into every active project (a project deleted
at the time never gets them), then records the setting `snippets_imported` and never imports again.
An empty or missing folder imports nothing and still sets the marker.

## 4. Registry (SQLite, `better-sqlite3`, file `${HATTISAR_DATA_DIR}/hattisar.db`)

Numbered migrations in `src/registry/migrations/`, applied at boot, tracked in
`schema_migrations`. WAL mode. Tables (names are binding; columns may gain indexes):

- `users(id, username UNIQUE, password_hash, created_at, updated_at)`
- `sessions(token_hash PK, user_id, created_at, expires_at)`
- `boxes(id, name UNIQUE, kind CHECK in ('shared','registered','managed'), dev_only INT,
  host, port, admin_user, admin_password_enc, sslmode, public_host, public_port,
  pooler_tenant NULL, pooler_session_port NULL, pooler_transaction_port NULL,
  container_name NULL, created_at)` — the three pooler fields are all set or all NULL; set means
  the box has a Supavisor tenant (§5.1).
- `projects(id, ref UNIQUE, name, box_id → boxes, db_name, owner_role,
  owner_password_enc, status CHECK in ('active','deleted'), deleted_at NULL,
  deleted_db_name NULL, created_at)`
- `settings(key PK, value)` — S3 config lives here; secret fields encrypted.
- `backup_schedules(project_id PK, frequency CHECK in ('off','daily','weekly'),
  keep_daily, keep_weekly)`
- `backups(id, project_id, kind CHECK in ('manual','scheduled'), s3_key, size_bytes,
  status CHECK in ('running','done','failed'), error NULL, created_at, finished_at NULL,
  bucket)` — `bucket` (migration 002) is where the object was written; delete/restore/retention use it.
- `api_tokens(id, user_id → users ON DELETE CASCADE, name, token_hash UNIQUE, prefix,
  created_at, last_used_at NULL, expires_at NULL)` — §15; `expires_at` NULL means never.
- `snippet_folders(project_id → projects ON DELETE CASCADE, id, name, created_at)`, primary key
  `(project_id, id)`, `name` unique per project — §3.3.
- `snippets(project_id → projects ON DELETE CASCADE, id, folder_id NULL → snippet_folders ON
  DELETE CASCADE, name, sql, inserted_at, updated_at)`, primary key `(project_id, id)`, `name`
  unique per project and folder (root included) — §3.3.

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

Every kind except a registered box with `sslmode` `require` or `verify-full` gets a pooler tenant
(§5.1).

**E1 compatibility check** (on register and edit, and before creating a managed box's first project),
connecting as the admin: `server_version_num` from 150000 up to, not including, 190000; extensions
`pgcrypto`, `uuid-ossp`, `pg_stat_statements` are in `pg_available_extensions`; admin is superuser
(the H2 baseline needs it for `pg_stat_statements`; `ALTER SCHEMA public OWNER` does not, on 15+).
No Supabase roles are required: any self-managed Postgres 15-18 passes, because hattisar never
uses `supabase_admin`, `anon`, `authenticated` or `service_role`, and never creates them on a
box. The cap is the bundled client's major: `pg_dump` refuses a newer server.
Hosted Postgres without a true superuser (RDS, Neon) fails the superuser check (#33).
Failure lists every unmet item. A box with projects (any status) cannot be removed.

### 5.1 Pooler tenants (J3)

One Supavisor, the compose `supavisor` service, pools every box with a tenant. Its session
(`POOLER_PORT_SESSION`) and transaction (`POOLER_PORT_TRANSACTION`) ports serve all tenants:
Supavisor takes the tenant from the user name after its last `.`, and the client's database name
picks the database, so one tenant per box covers all its projects. Supavisor runs the auth query
in the tenant's `postgres` database as the tenant's manager role, so project databases need
nothing for it.

- **shared** — tenant `POOLER_TENANT_ID`, created by `docker/volumes/pooler/pooler.exs` when
  Supavisor starts (manager `pgbouncer`, `pgbouncer.get_auth`). hattisar never changes it.
- **managed**, and **registered with `sslmode = disable`** — tenant `<POOLER_TENANT_ID>-<box name>`
  (`-<box id>` appended if another box already stores that id), created by hattisar. The id is
  stored once and kept when the box is renamed: it is in every app's connection string.
- **registered with `require` or `verify-full`** — none. Clients reach Supavisor without TLS, and
  Supavisor cannot check an upstream host name; pooling these is a follow-up.

**Ensure** runs after a managed box is created or started, after a box is registered or edited,
and for every eligible box at boot (after listening, never holding up boot) and every 10 minutes
after, so a box left without a tenant while Supavisor was down catches up:
1. Box stores a tenant: `GET /api/tenants/<id>`. Present with the box's `db_host` and `db_port` →
   done. Supavisor terminates a tenant's pools on every update, so an unchanged tenant is never PUT.
   Present but different (the box moved), or 404 → step 2, keeping the stored id.
2. As the box admin, in `postgres`: create or alter the tenant's own role
   `hattisar_pooler_<first 12 hex of HMAC-SHA256(HATTISAR_SECRET_KEY, tenant id)>` `LOGIN PASSWORD` with the SCRAM verifier
   of a new random password. One role per tenant, because several boxes (or hattisar installs) can
   point at one server and a shared role's new password would break the other tenants; the key
   keeps two installs with the same tenant id apart. Then
   `CREATE SCHEMA IF NOT EXISTS hattisar_pooler`; `CREATE OR REPLACE FUNCTION
   hattisar_pooler.get_auth(p_usename text) RETURNS TABLE(username text, password text) LANGUAGE
   sql SECURITY DEFINER SET search_path = ''`, returning `rolname` and `rolpassword` (NULL once
   `rolvaliduntil` has passed) from `pg_catalog.pg_authid` where `rolname = p_usename AND
   rolcanlogin AND NOT rolsuper`; `EXECUTE` revoked from `PUBLIC` and granted, with `USAGE` on the
   schema, to the tenant's role. The password is new on every (re)create and hattisar never
   stores it.
3. `PUT /api/tenants/<id>` with the full tenant below. Supavisor logs in as the tenant's role and
   runs the auth query before creating it; a leftover tenant with that id is overwritten, its
   users included.
4. Only then store `pooler_tenant` and the two ports.

```json
{"tenant": {"db_host": "<host>", "db_port": 5432, "db_database": "postgres",
  "require_user": false, "auth_query": "SELECT * FROM hattisar_pooler.get_auth($1)",
  "upstream_ssl": false, "ip_version": "auto", "default_pool_size": 20, "default_max_clients": 100,
  "users": [{"db_user": "<tenant role>", "db_password": "<password>", "mode_type": "transaction",
             "pool_size": 20, "is_manager": true}]}}
```

**Drop** (box removed, or a registered box edited to `require`/`verify-full`):
`GET /api/tenants/<id>/terminate`, then `DELETE /api/tenants/<id>` (404 counts as done), then clear
the pooler fields. Best effort: a failure is logged and the removal goes on; a later tenant with
the same id overwrites the leftover (step 3). On a registered box hattisar then drops the tenant's
role as the box admin, also best effort; the `hattisar_pooler` schema and function stay, since
other tenants on that server may use them.

**Re-sync** (Re-sync pooler on the Boxes page, `POST /boxes/:id/pooler/resync`, `hattisar boxes
resync-pooler <id>`) runs steps 2–4 for one box on demand, with the stored tenant id (a new one,
as ensure picks it, if the box has none), queued with ensure and drop for that box. It fixes a
tenant whose role password no longer matches Supavisor's, as after a box restore
([`docs/pitr.md`](pitr.md)), which ensure does not notice. The PUT terminates the tenant's pools,
so open pooled connections drop. Refused for the shared box and for a box that requires TLS; on failure the stored pooler
fields stay as they were and the scrubbed reason is shown.

**Supavisor down or refusing:** the box is saved without pooler fields, its projects get the
direct string only, the Boxes page shows "Pooler pending" for it, and the next ensure
retries. Messages shown or logged have the generated and box admin passwords scrubbed.

hattisar reaches the API at `http://supavisor:4000` (compose network only, no published port) with
`Authorization: Bearer <JWT>`: HS256 with `POOLER_JWT_SECRET` (Supavisor's `API_JWT_SECRET`),
claims `{"exp": <now + 60 s>}`. Every boot rewrites the two pooler ports from env on each box that
has a tenant, as it does for the shared box.

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
- API tokens authenticate the JSON API and the CLI, and only those; the session cookie never does
  (§15).

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
   Nothing for the pooler: its auth query runs in the box's `postgres` database (§5.1).
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
- box with pooler fields: session
  `postgresql://<owner>.<tenant>:<pw>@<HATTISAR_PUBLIC_HOST>:<session_port>/<db>` and transaction
  (same, `<transaction_port>`). The host is always `HATTISAR_PUBLIC_HOST`, where Supavisor is
  published, never the box's `public_host`.
- direct: `postgresql://<owner>:<pw>@<public_host>:<public_port>/<db>`, on every box except the
  shared one, whose `db` publishes no port.
- order: session, transaction, direct; a box without pooler fields has only direct.
- shared/dev-only boxes show a "development only" badge.

**Rotate owner password:** `ALTER ROLE … PASSWORD …`, store encrypted, show new strings. Never
reads the old password, so it works when the stored one will not decrypt. On a box with a tenant,
one login through the pooler with the new password follows, because Supavisor refetches a cached
secret only after a login fails.

**Soft delete (M2)** — confirm by typing the ref: `REVOKE CONNECT … FROM <owner>`; terminate
backends on the db; `ALTER DATABASE <db> RENAME TO <db>__deleted_<YYYYMMDD>` (suffix `_2`, `_3`…
on collision); status `deleted`, `deleted_at`, `deleted_db_name`. Hidden from Studio and the
project list; shown under Trash.

The owner role **keeps LOGIN**. Apps still running against a deleted project then pass pooler
authentication and fail on `CONNECT`, instead of failing authentication — Supavisor counts auth
failures per tenant/IP and would otherwise lock out every project on the box. Revoked
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
project and retries next hour. A dump download holds the project too, from before `pg_dump`
starts until it exits (finished, failed, or killed because the client went away); a download
refused this way answers 409 on the Backups tab.

## 8. Backups

`pg_dump`/`pg_restore` from `HATTISAR_PG_BIN_DIR` (image ships PostgreSQL 18 client). Passwords
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
  §7 create flow, then the same restore. A failed restore leaves the error on the page. A
  restore whose only pg_restore errors are `unrecognized configuration parameter` on a `SET` (a
  newer client's setting an older server lacks, such as `transaction_timeout` on 15) succeeds
  and logs a warning. Leftover `restore-*` work directories are removed at boot.
- Docs state plainly: dumps restore to the last dump, not a point in time. [`docs/pitr.md`](pitr.md)
  is a tested WAL-G recipe for point-in-time recovery of managed boxes and the shared box. It is
  box-level, restoring every project on the box at once, and lives outside hattisar: the operator
  runs it on the Docker host and hattisar has no part in it.

## 9. UI

Server-rendered Hono JSX, one stylesheet, no client framework; tiny inline scripts only for copy /
reveal, live search and loading sizes. The theme follows `prefers-color-scheme` unless the user menu
(top right of every page: username, Settings, System / Dark / Light, Log out) picks one: `POST
/_hs/theme` stores `hs_theme=light|dark` (or clears it for System) and the server renders
`<html data-theme>` from it, so there is no flash. Pages: Login, Projects, New project (name, ref with live slug hint, box picker — each
option labelled; dev-only boxes carry the warning "Best for development only — shares one Postgres
with other projects"), Project (three tabs, below), Trash, Boxes (list, register, edit, remove,
"New managed box" when enabled; each row shows its pooler tenant, "Pooler pending" when an
eligible box has none yet, or "Direct only"), Settings. Errors render inline, never as a stack trace.

Projects (`/_hs/projects`) shows the active projects as cards or as a list. `?view=grid|list`
picks the view and is remembered in `hs_projects_view`; `?q=` filters by name or ref (the inline
script also filters as you type); `?sort=name|created` orders by name or newest first, and the
list's Project and Created headers link to those sorts. Each card or row shows the name, ref, status
(`ACTIVE`, or `BUSY` while §7's lock or a running backup holds it), the box's kind (`SHARED · DEV`
for the dev-only shared box), the box, the created date and the database size. Clicking it opens
Studio at `/project/<ref>/editor`; its ⋮ menu has Open in Studio, Project settings
(`/_hs/projects/<ref>/settings`) and Delete (that tab's delete form, `#delete`). Connection strings
stay on the project page, so the list never carries a password. A Trash link shows the deleted
count. A Boxes panel beside the projects lists each box with its active project count and the
total size of those databases.

A project's page has a breadcrumb (Projects / name), Open in Studio, and a section nav like
Settings' with three tabs. **Connect** (`/_hs/projects/<ref>`, the default, where Studio's Connect
button and a new project land): connection strings and rotate password. **Backups**
(`/_hs/projects/<ref>/backups`): download dump, back up now, schedule, the backups list with
restore and delete. **General** (`/_hs/projects/<ref>/settings`): ref, box, database, owner role,
display name, and Delete project in a danger section at the bottom. Each form returns to its own
tab: a success redirects there with a `?notice` key, a failure re-renders that tab with the error.

Sizes come from `GET /_hs/usage` after the page loads, so a slow box never delays the page: one
`pg_database_size` query per box that has active projects, in parallel, through the box's admin
connection (§5 timeouts). A box that fails shows as unreachable and its projects show no size. A
box without active projects is not queried; a managed one is stopped then (§10).

Settings has a section nav (Account, API tokens, Backup storage): `/_hs/settings` → 302
`/_hs/settings/storage`. Account (`/_hs/settings/account`) shows the signed-in username and the
change-password form, posting to `/_hs/settings/password`. API tokens (`/_hs/settings/tokens`)
lists, creates and revokes tokens (§15). Backup storage (`/_hs/settings/storage`) shows whether S3
is configured (bucket, endpoint host) above the S3 form, which posts to `/_hs/settings/s3` and, for
"Test connection", `/_hs/settings/s3/test`. Each POST re-renders the section it belongs to, except
revoking a token, which redirects back to the list.

## 10. Managed boxes (O4 + O2)

Off unless `HATTISAR_MANAGED_BOXES=true`. Then compose profile `managed-boxes` runs
`docker-proxy` (tecnativa/docker-socket-proxy) with `CONTAINERS=1 IMAGES=1 VOLUMES=1 NETWORKS=1
POST=1` and everything else (EXEC, BUILD, SWARM, …) off; hattisar talks to `DOCKER_HOST` only.

Create: name (`^[a-z][a-z0-9-]{2,39}$`), image = the pinned `supabase/postgres`, random admin
password, volume `hattisar_box_<name>`, container `hattisar-box-<name>` on the compose network,
host port = first free in `HATTISAR_MANAGED_PORT_RANGE` (default `55000-55999`), labels
`hattisar.managed=true`, `hattisar.box=<name>`. Wait until ready, run E1, register as kind
`managed` (`host` = container name, `port` 5432, `public_host` = `HATTISAR_PUBLIC_HOST`,
`public_port` = the host port), then ensure its pooler tenant (§5.1). The New-project form
offers "New dedicated box" which does this then creates the project on it.

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
drops its pooler tenant (§5.1) and removes container and volume.

Operator mounts: `HATTISAR_MANAGED_BOX_MOUNTS` lists comma-separated `<host source>:<container
target>` entries, which hattisar adds as read-only binds to every managed container it creates.
`{box}` in a source becomes the box name (box names cannot hold `/` or `..`). Config load refuses a
relative path, a `..` segment, `{box}` in a target, a target that is the data dir, inside it or one
of its ancestors, a target used twice, and an empty entry. Existing containers are never changed. A
missing source makes Docker refuse the create; box creation fails with Docker's message and rolls
back. Environment variables are not offered: WAL-G reads `--config`, and env would put secrets in
`docker inspect`. The PITR recipe ([`docs/pitr.md`](pitr.md)) mounts WAL-G and a per-box config
this way.

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
| `HATTISAR_MANAGED_BOX_MOUNTS` | — | read-only bind mounts for new managed boxes (§10) |
| `DOCKER_HOST` | `tcp://docker-proxy:2375` | managed boxes only |
| `STUDIO_URL` | `http://studio:3000` | |
| `PG_META_URL` | `http://meta:8080` | |
| `PG_META_CRYPTO_KEY` | — | shared with meta |
| `HATTISAR_PG_META_TIMEOUT_SECONDS` | `120` | hattisar's own `/query` and `/generators/typescript` calls; 504 when exceeded; the timeout only stops hattisar waiting, postgres-meta keeps running the statement until its own query timeout |
| `POSTGRES_PASSWORD` | — | shared box admin |
| `POOLER_TENANT_ID`, `POOLER_PORT_SESSION` (54322), `POOLER_PORT_TRANSACTION` (6543) | | shared box tenant and the pooler ports for every tenant; other tenant ids are prefixed with `POOLER_TENANT_ID` (§5.1) |
| `POOLER_JWT_SECRET` | — | required; Supavisor's `API_JWT_SECRET`, which hattisar signs its tenant API calls with (§5.1) |
| `POOLER_SECRET_KEY_BASE`, `POOLER_VAULT_ENC_KEY` | — | Supavisor's own secrets; generated by `scripts/dev-env.sh` |

`HATTISAR_PORT` is the host-published port only; the app listens on 8000 inside the container.
`DOCKER_HOST` is set explicitly in compose for the `managed-boxes` profile, never inherited from
the host shell.

## 12. Pinned images (official self-hosted, supabase `master` 4b5b2a3, 2026-10-20)

`supabase/studio:2026.10.12-sha-3699278` · `supabase/postgres-meta:v0.100.0` ·
`supabase/postgres:17.6.1.136` · `supabase/supavisor:2.9.13`. Bumping any of them requires the
routing e2e (§13) to pass. `caddy:2.11.7` (the installer's `caddy` profile, §17) is outside that
rule: it never reaches a project database.

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

The post-v1 roadmap is the GitHub milestone "Roadmap": a release pipeline (§16), a one-line
installer (§17), per-project SQL snippets (§3.3), pooler for non-shared boxes (J3, §5.1), a WAL-G
point-in-time recovery recipe in the docs (shipped: [`docs/pitr.md`](pitr.md)), and plain-Postgres
boxes (E3, shipped: §5). Parked, each until its condition holds:

| Parked | Revisit when |
|---|---|
| Multi-user (F2) | someone asks to share one hattisar |
| Boxes on other Docker hosts (O3) | hattisar runs on more than one server |
| Add-on mode for the full official stack (K1) | a user needs Supabase features beyond the database |
| Auth / REST / Storage per project | same as K1 |
| Point-in-time recovery inside hattisar | the documented box-level recipe is not enough |

## 15. API and CLI

A JSON API for scripts and the `hattisar` CLI. It covers projects, connection URLs, backups and
listing boxes. Migrations stay with the official `supabase` CLI, which takes a project's URL via
`--db-url`.

### 15.1 API tokens

- A token is `hs_` + 32 random bytes, base64url. It is shown once, in a readonly field on the
  page that created it (rendered, never redirected, so it is in no URL), and stored only as its
  SHA-256 hash, with its first 10 characters kept as `prefix` for display.
- No scopes: a token acts as its user with full rights; `canAccess` still decides per project.
- Expiry is chosen at creation: 30, 90 (default) or 365 days, or never. An expired token answers
  401 and its row is deleted, on use and by the hourly purge, as an expired session is. Until then
  Settings marks it `expired`.
- Revoking deletes the row. Changing the password does not revoke tokens; Settings → API tokens
  lists every token (name, `prefix…`, created, last used, expires) and revokes them one by one. A
  token id of another user → 404.
- `last_used_at` is written on every authenticated API request.
- After creating a token the page names the next step, `hattisar login <origin>`, with `https`
  when `HATTISAR_COOKIE_SECURE=true`.

### 15.2 Authentication and routing

The API is mounted at `/_hs/api`; every path under it, versioned ones under `/_hs/api/v1`, first
passes `requireApiToken`, so an unknown `/_hs/api/*` path is 401 without a token and 404 JSON with
one, never the HTML page.

- It accepts only `Authorization: Bearer <token>` (scheme case-insensitive) and never the session
  cookie. A bearer token is accepted nowhere else: the UI and Studio's routes ignore it.
- The session check and the same-origin check (§6) are skipped for the API: with no cookie there
  is no CSRF. The skip applies only when the **raw** request path is under `/_hs/api` **and** the
  route classifier calls it `hattisar-api`. The classifier decodes `%2F` and Hono's router does
  not, so a path only the classifier calls API would otherwise reach a non-API handler with no
  session and no origin check.
- The Studio proxy strips an `Authorization` header that carries an `hs_` bearer before passing a
  request on; any other `Authorization` (Studio's own) passes through.

### 15.3 Errors and confirmation

Errors use one shape across `/api` and `/_hs/api`: `{ "error": { "message": string,
"problems"?: string[] } }`.

| Status | When |
|---|---|
| 400 | Bad input, with `problems`; a failed create (as in the UI); `newBox` with managed boxes off; S3 not configured for a backup or restore. |
| 401 | Missing, unknown or expired token: `Missing or invalid API token`. |
| 404 | Unknown, deleted (unless asked for) or forbidden project; a backup not of that project or not `done`; unknown path. |
| 409 | The service failed and the project is held by another operation or a running backup (§7). |
| 502 | The service failed otherwise (box or S3); an owner password that will not decrypt. |
| 500 | Unexpected: `app.onError` answers JSON for `/_hs/api/` as for `/api/`. |

Destructive endpoints — soft delete and restoring a backup — require the body
`{"confirm": "<ref>"}`, the API's form of the UI's type-the-ref. The CLI sends it only from
`--confirm <ref>`.

The API calls the same service functions as the UI (create, create on a new managed box, rotate,
soft delete, restore from Trash, back up, restore a backup), so validation, locking and SQL are
shared.

### 15.4 Endpoints (all JSON, under `/_hs/api/v1`)

| Method & path | Body | 2xx response |
|---|---|---|
| `GET /me` | – | `{ username }` |
| `GET /boxes` | – | `[{ id, name, kind, devOnly, publicHost, publicPort }]`; never host, admin user or secrets |
| `POST /boxes/:id/pooler/resync` | – | `{ tenant }` (§5.1 re-sync). 400 for the shared box or one that requires TLS, 404 for an unknown box, 502 when the box or Supavisor fails |
| `GET /projects?status=active\|deleted` | – | `[project]`, active by default. A project is `{ ref, name, status, box: { id, name, kind }, createdAt, deletedAt }` |
| `POST /projects` | `{ name, ref?, boxId?, newBox? }` | 201 `project`. `ref` defaults to the slug of `name`, `boxId` to the shared box; `newBox: true` creates a managed box named after the ref (400 if managed boxes are off, or with `boxId`) |
| `GET /projects/:ref` | – | `project` + `connections: [{ label, kind, masked }]`, `kind` `direct`, `session` or `transaction`; empty when the password will not decrypt |
| `GET /projects/:ref/connections` | – | `[{ label, kind, url }]` with the real password, in the project page's order |
| `POST /projects/:ref/rotate` | – | `{ ok: true }` |
| `DELETE /projects/:ref` | `{ confirm }` | `{ ok: true }` (soft delete) |
| `POST /projects/:ref/undelete` | – | `project`; looks up deleted projects only, 404 if not in Trash |
| `GET /projects/:ref/backups` | – | `[{ id, kind, status, sizeBytes, error, createdAt, finishedAt }]`; no bucket or S3 key |
| `POST /projects/:ref/backups` | – | 201 the backup, after it finished |
| `POST /projects/:ref/backups/:id/restore` | `{ confirm }` | `{ ok: true }` |

Restore means into the same project only; restore into a new project stays in the UI.

### 15.5 CLI

`cli/` is a separate package, `hattisar`, bin `hattisar`, Node ≥ 24, **no runtime dependencies**
(`fetch`, `node:util` `parseArgs`, `node:readline`). It is not a pnpm workspace member, so
installing it pulls none of the server's dependencies and the Dockerfile and lockfile do not
change. `pnpm build:cli` empties `cli/dist/` and compiles into it (CI runs it); the package's
`prepack` runs it, so a pack or publish never ships stale files. Releases are tag-driven: pushing
`cli-v<version>` (matching `cli/package.json`, on a commit in `main`) runs
`.github/workflows/release-cli.yml`, which tests, packs once, publishes that tarball to npm with
provenance and attaches it to a GitHub release. npm auth is trusted publishing (OIDC), or the
`NPM_TOKEN` secret when set.
`run(argv, io)` in `cli/src/run.ts` takes `fetch`, the streams, `env` and the config directory and
returns the exit code; unit tests drive it against the in-process app.

```
hattisar login <url>                 hattisar logout              hattisar whoami
hattisar projects list [--deleted]
hattisar projects create <name> [--ref <ref>] [--box <id> | --new-box]
hattisar projects show <ref>
hattisar projects url <ref> [--transaction | --direct]
hattisar projects rotate <ref>
hattisar projects delete <ref> --confirm <ref>
hattisar projects restore <ref>
hattisar backups list <ref>
hattisar backups run <ref>
hattisar backups restore <ref> <backup-id> --confirm <ref>
hattisar boxes list
hattisar boxes resync-pooler <id>
Global: --json, --help, --version
```

- `projects restore` takes a project out of Trash; `backups restore` replaces a project's data
  with one of its backups. `--confirm` must equal the ref, else exit 2 before any request.
- `projects url <ref>` prints exactly one URL with the real password: the first connection (the
  session pooler on a box with a tenant, direct otherwise), so `$(hattisar projects url x)` works.
  `--transaction` picks the transaction pooler and exits 1 if the box has none; `--direct` picks
  the direct connection and exits 1 if there is none (the shared box). Both together exit 2.
- `login <url>` reads the token from a hidden prompt on a TTY, or from stdin otherwise, checks it
  with `GET /me` and only then saves it. There is no flag for the token: secrets stay out of argv.
  A URL with credentials, a query or a fragment, or not http(s), is refused without being echoed.
  An `http:` URL whose host is not `localhost`, `127.0.0.1` or `[::1]` gets a stderr warning,
  `warning: http sends the token unencrypted`, and login goes on.
- A token, whether typed, from `HATTISAR_TOKEN` or from the config, is trimmed and must match
  `hs_[A-Za-z0-9_-]+`; otherwise exit 3 with `the token is not valid` before any request, so a
  stray line or control character never reaches a header (whose error would quote it).
- Requests do not follow redirects: a 3xx exits 1 with `<url> redirected to <location> — log in
  with that URL instead` (location without credentials, query or the API path), rather than
  resending the token or losing it on an http → https hop.
- Config is `$XDG_CONFIG_HOME/hattisar/config.json` (default `~/.config/hattisar/config.json`),
  `{ url, token }`, directory 0700, file 0600. `HATTISAR_URL` and `HATTISAR_TOKEN` override it.
  The saved token is sent only to the saved URL: a `HATTISAR_URL` naming another server needs
  `HATTISAR_TOKEN` too, so an environment variable cannot send the token elsewhere. `logout`
  deletes the file.
- Output is human tables by default; `--json` prints the API's JSON verbatim (indented), except
  `projects url --json`, which prints the chosen connection object; `logout` has no JSON output.
  Errors go to stderr as one line `hattisar: <message>`, followed by `  - <problem>` lines; a
  network failure reads `hattisar: cannot reach <url>`, plus `: <code>` when the system gave one
  (`ECONNREFUSED`): the request layer's message is never shown, as it can quote headers. The
  token never appears in output.

| Exit | Meaning |
|---|---|
| 0 | OK |
| 1 | API or network error |
| 2 | Usage error (unknown command or option, missing argument, wrong `--confirm`) |
| 3 | Not logged in, or the token was refused (401) |

## 16. Server releases

A server release is a `v<version>` tag (first `v0.1.0`), separate from the CLI's `cli-v*` tags
(§15.5). `.github/workflows/release.yml` runs on it:

1. Refuses a tag whose commit is not on `main`, or whose version is not `package.json`'s.
2. Runs lint, typecheck and the unit tests.
3. Builds the `runtime` stage of `docker/Dockerfile` for `linux/amd64` and `linux/arm64` and
   pushes it to `ghcr.io/itsbohara/hattisar` as `<version>`, `<major>.<minor>` and `latest`, with
   the `org.opencontainers.image.source` label pointing at the repository. A prerelease (a version
   containing `-`) gets only the `<version>` tag.
4. Smoke-tests the pushed image on each platform, then checks it can be pulled anonymously.
5. Builds the bundle `hattisar-<version>.tar.gz` with `scripts/release-bundle.sh` and creates the
   GitHub release `v<version>` with the bundle and `install.sh` (§17) attached and generated
   notes, marked prerelease for a prerelease version.

The bundle unpacks to `hattisar/`: `compose.yml`, `env.example`, `generate-env.sh`, `volumes/` (the
db init SQL, `pooler.exs` and the `Caddyfile`), `NOTICE`, and `compose.walg.yml` and
`wal-g/Dockerfile` (the PITR recipe, [`docs/pitr.md`](pitr.md)): the same layout as `docker/` plus
the env generator.
Its `compose.yml` is `docker/compose.yml` with the hattisar image's default tag replaced by the
exact version, so an install never drifts: `sh generate-env.sh env.example .env` (fresh secrets,
never overwriting an existing `.env`), review `.env`, `docker compose up -d`. Nothing is built.

`docker/compose.yml` names the image `ghcr.io/itsbohara/hattisar:${HATTISAR_VERSION:-latest}` and
has no `build:`. Building from source is an override: `docker/compose.dev.yml` (the `dev` stage,
for development and CI) and `docker/compose.source.yml` (the `runtime` stage, for running a
checkout in production mode).

The GHCR package is public; a package's first push can create it private, in which case it is made
public once in its settings. Public packages cost nothing to store or pull.


## 17. Installer

`install.sh` is attached to every server release (§16), so the one-line install is

```sh
curl -fsSL https://github.com/itsbohara/hattisar/releases/latest/download/install.sh | sudo sh
```

and `| sudo sh -s -- <options>` passes options. It is POSIX sh, wrapped in one function called on
its last line, so a truncated download runs nothing. It runs on Linux `x86_64` and `aarch64` with
curl, openssl, Docker and Compose v2, and refuses anything else before touching the disk.

Options: `--dir <path>` (default `/opt/hattisar`), `--version <x.y.z>` (default: the latest
release, from the redirect of `releases/latest`, so prereleases are never picked by default),
`--domain <name>` or `--no-domain`, `--managed-boxes` or `--no-managed-boxes`, and `--yes` (take
the defaults for every unanswered question: no domain, managed boxes on). Questions are read from
`/dev/tty`, since stdin is the script itself; with no terminal and an unanswered question it stops
with exit 2 naming the flag to pass.

The download is unpacked into a temporary directory and the images are pulled from there; the
install directory is written only after that succeeds (and, on an upgrade, after the backup), so a
failure before then leaves it as it was. A bundle whose `compose.yml` lacks `HATTISAR_BIND`, or,
when a domain is served, has no `volumes/caddy/Caddyfile`, predates the installer and is refused.

**First install** (the directory has no `.env`):

1. Refuses if Docker volumes of the compose project the directory would form already exist: they
   hold an earlier install's data, encrypted with its `.env`. Restoring that `.env`, or
   `docker compose down -v` in the old install as a deliberate reset, is the way on.
2. Asks "Domain for hattisar (empty: localhost only)". With a domain it sets
   `HATTISAR_DOMAIN`, `HATTISAR_PUBLIC_HOST` to the domain and `HATTISAR_COOKIE_SECURE=true`, and
   enables the `caddy` profile: Caddy serves the domain on 80/443 with a Let's Encrypt certificate
   and proxies to hattisar. Either way `HATTISAR_BIND=127.0.0.1`, so hattisar's own port is never
   public; without a domain it is reached through an SSH tunnel or the operator's own proxy.
3. Asks "Enable managed boxes? [Y/n]", noting that hattisar then reaches Docker through the
   socket proxy (§10). Yes sets `HATTISAR_MANAGED_BOXES=true` and adds `managed-boxes` to
   `COMPOSE_PROFILES`.
4. Downloads `hattisar-<version>.tar.gz` from the release; `generate-env.sh env.example .env`
   writes fresh secrets, and the answers go into `.env`, including `COMPOSE_PROFILES`, so a plain
   `docker compose up -d` in the directory keeps them.
5. `docker compose pull`, copies the bundle and `.env` into the directory, `docker compose up -d
   --wait`.
6. Prints the URL, the admin username and the admin password.

**Re-running it upgrades** (the directory has a `.env`): no questions; answer flags are ignored
with a note, since `.env` is edited by hand. It downloads the bundle, pulls, stops hattisar, and
copies the registry (`hattisar.db` and any `-wal`/`-shm`) to `<file>.bak-<old version>` inside the
`hattisar-data` volume when it exists; a `hattisar.db.bak-<old version>` left by an earlier attempt
is kept with its set, never overwritten. Only then does it replace every bundle file but never
`.env`, run `generate-env.sh` to add keys new in `env.example` (§16), and start the stack. The old
version is read from the pinned image line of the `compose.yml` being replaced. It prints the URL
but not the password, which may have changed since first boot. A version below the installed one
(numeric major.minor.patch, a prerelease below its release) is refused, since the registry may
carry migrations it cannot read; the refusal prints the manual rollback (restore the `.bak-<version>`
files, set `HATTISAR_VERSION` in `.env`), as does a failed start after an upgrade.

`generate-env.sh <template> <target>` writes a missing target with every secret generated; on an
existing target it appends each key the template has and the target lacks, generating it if it is
a secret and copying the template's value otherwise, and never changes an existing line. If a
secret cannot be generated (no openssl) it fails, leaving a missing target unwritten.

`docker/compose.yml` publishes hattisar on `${HATTISAR_BIND:-0.0.0.0}:${HATTISAR_PORT:-8000}`; a
checkout keeps today's behaviour. The `caddy` service (profile `caddy`, pinned `caddy` image) reads
`volumes/caddy/Caddyfile` from the bundle, keeps certificates in the `caddy-data` volume, and is
the only service the installer publishes on all interfaces apart from the pooler
ports (§5.1), which apps on other hosts use.
