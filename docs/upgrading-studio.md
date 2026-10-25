# Upgrading Studio and the pinned images

hattisar works because of how one specific Studio build reaches its database (design §1). A new
Studio can add a route that reads the database some other way, so the images are pinned and a bump
is gated on the routing e2e.

## What is pinned, and where

All four come from one official self-hosted release: the `docker/` directory of
`github.com/supabase/supabase` at one commit (currently `4b5b2a3`). Bump them together, to the
versions that commit's `docker/docker-compose.yml` uses.

| Image | Pinned in |
|---|---|
| `supabase/studio` | `docker/compose.yml` |
| `supabase/postgres-meta` | `docker/compose.yml` |
| `supabase/postgres` | `docker/compose.yml`, `src/managed/service.ts` (`MANAGED_IMAGE`), `test/unit/managed-service.test.ts`, `test/integration/managed-boxes.test.ts`, `scripts/pitr-test.sh`, `docs/pitr.md` |
| `supabase/supavisor` | `docker/compose.yml` |

Also record the new versions and commit in `docs/design.md` §1 (Studio tag) and §12, and the
commit in `docker/NOTICE`.

`tecnativa/docker-socket-proxy` and `rustfs/rustfs` (dev and tests only) are pinned too but are
not part of the Supabase release; bump them on their own.

## Steps

### 1. Record the current API inventory

On the current pins, with the stack up, run the routing spec with the HTML reporter and keep the
`api-inventory.json` attachment:

```sh
pnpm stack:up
pnpm exec playwright test e2e/routing.spec.ts --reporter=html
pnpm exec playwright show-report      # open the test, save the api-inventory.json attachment
```

The attachment lists every `/api/**` route Studio called while visiting each screen in
`e2e/studio-screens.ts` (refs and numeric ids normalised to `:ref` / `:id`), every pg-meta request
and which database hattisar resolved it to, every failed call, and any request that bypassed
hattisar (a Postgres `FATAL` for `hattisar_no_project` in the `db` log).

### 2. Read the new Studio source

At the commit the new Studio image was built from (the `sha-…` suffix of its tag), re-check the
facts in design §1 in `apps/studio`:

- `lib/api/self-hosted/util.ts` — how `/api/platform/pg-meta/<ref>/query` builds the connection.
- `lib/api/apiHelpers.ts` `constructHeaders` — that the other pg-meta routes still relay
  `x-connection-encrypted`.
- `lib/api/self-hosted/{lints,migrations,mcp}.ts` and any new caller of `executeQuery` — routes
  that query through Studio's own env connection. hattisar must 404 or redirect each one.
- `pages/api/platform/projects/*` and `pages/api/v1/projects/*` — the project shapes hattisar
  imitates (design §3.1) and the `databases` / `types/typescript` routes it answers itself.
- `lib/api/self-hosted/settings.ts` `getProjectSettings` — the stub shape the `settings` route
  spreads (design §3.1): hattisar overrides only a few fields and passes the rest through.
- The encryption (`crypto-js` AES, passphrase mode) and the env names in `docker/compose.yml`.

A route that builds its connection from Studio's env fails closed — it lands on
`hattisar_no_project` — so it cannot leak another project's data, but the screen using it breaks.
Decide per route: redirect it in `src/studio/`, answer 404, or accept the broken screen; record
the decision in design §3.

### 3. Bump the pins

Edit every location in the table above. Re-sync `docker/volumes/` from the same release, keeping
the modifications listed in `docker/NOTICE` (the `pgbouncer`-only password in `roles.sql`).

For `supabase/postgres`:

- A new **major** version needs a matching client in `docker/Dockerfile` (`postgresql<N>-client`):
  `pg_dump` must be at least the server's major version. Existing shared-box volumes need a
  dump/restore; they do not upgrade in place.
- Managed boxes already running keep their old image; upgrading them is not supported in v1
  (design §10).
- Run `sh scripts/pitr-test.sh`. It checks that the new image still ships no WAL-G and that the
  [PITR recipe](pitr.md) still archives and restores on it. A new major also needs a new WAL-G
  prefix per box.

### 4. Run everything on a fresh stack

```sh
pnpm stack:down -v
pnpm stack:up
pnpm lint && pnpm typecheck && pnpm test
pnpm test:it
pnpm test:e2e
```

**`e2e/routing.spec.ts` is the GO / NO-GO gate.** It creates two projects on one box and, for
project B, opens every screen in `e2e/studio-screens.ts`. It passes only when every pg-meta request
was resolved by hattisar to B's database, B's table is visible and A's is not, no pg-meta call
returned 5xx, no failure mentions `hattisar_no_project`, and the `db` log shows no request that
bypassed hattisar. If it fails, do not bump.

`e2e/studio-polish.spec.ts` checks the sidebar entries hattisar hides and the "← hattisar" link.
`src/ui/static/studio.css` matches sidebar links by `href` (Studio's class names change per build)
and `studio.js` anchors on the top bar's `<header>`; update them if Studio moved either.
It also checks that the Connect button and a `?showConnect=true` URL land on hattisar's project
page; `studio.js` keys that redirect on Studio's `showConnect` query parameter (design §3), so if
Studio opens its Connect sheet some other way, update the redirect.
`e2e/studio-owner.spec.ts` checks that a table made in the Table Editor belongs to the project's
owner role.

### 5. Compare the inventory

Run step 1 again on the new pins and diff the two `inventory` lists. For every new pattern:

- Does it read or write a database? Classify it against the request table in design §3 and make
  sure `src/studio/` handles it.
- Is it a new Studio screen that reads the database? Add it to `e2e/studio-screens.ts` so the
  routing gate covers it from now on.

Commit the bump only with the routing e2e green and the inventory differences accounted for.
