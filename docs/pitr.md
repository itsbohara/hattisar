# Point-in-time recovery with WAL-G

hattisar's backups are `pg_dump` files: a restore returns a project to the moment of the dump. This
recipe adds continuous WAL archiving with [WAL-G](https://github.com/wal-g/wal-g), so a box can go
back to any second you choose.

**PITR restores a whole box, not one project.** Every database and role on the box goes back to the
same moment: all its projects, and for the shared box also Supavisor's metadata. To get back one
project, see [Getting back one project](#getting-back-one-project).

The recipe lives outside hattisar. hattisar runs no part of it and knows nothing of it: you run
every command below on the Docker host. It covers managed boxes and the shared box. A registered box
is your own Postgres; set up PITR there with its own tools.

- **RPO about 60 s.** `archive_timeout = '60s'` closes and ships the current WAL segment at least
  once a minute while there are writes. Lose the box's disk and you lose about the last minute.
- **Tested** by [`scripts/pitr-test.sh`](../scripts/pitr-test.sh), against the S3-compatible
  RustFS that the dev stack runs. Real AWS S3 and R2 are not tested; see
  [What is not tested](#what-is-not-tested).

Run the commands in the release directory (`/opt/hattisar` with the installer), or in `docker/` in a
checkout. `<name>` is the managed box's name: its container is `hattisar-box-<name>` and its volume
`hattisar_box_<name>`. The shared box is container `hattisar-db-1`, service `db`, volume
`hattisar_db-data`.

## Build WAL-G

The pinned `supabase/postgres` image ships no WAL-G, and it is Alpine, so WAL-G's release binaries
do not run in it. Build a static binary (WAL-G 3.0.9, with libsodium) into `walg/wal-g`:

```sh
docker build -f wal-g/Dockerfile -o walg wal-g
```

From the root of a checkout: `docker build -f docker/wal-g/Dockerfile -o docker/walg docker/wal-g`.
The build takes a minute or two and runs for the host's architecture. Building WAL-G 3.0.9 by hand
needs `GOEXPERIMENT=jsonv2`; the Dockerfile sets it.

## S3 prefix, keys and encryption

Use the same bucket as hattisar's backups, under a prefix of its own:

```
s3://<bucket>/pitr/<box name>-<YYYYMMDD of enabling>
```

- Never put it under hattisar's own prefix (Settings → Backup storage): a project ref could clash
  with it.
- Use a new prefix per cluster. Purging a box leaves its prefix in S3, and a later box with the same
  name is a different cluster; the date keeps them apart. A clone, and a new Postgres major
  version, also get a new prefix.
- Prefer a separate access key, limited to `pitr/` where your provider allows it. hattisar never
  shows its stored S3 secret anyway.

The settings, with the same meaning as hattisar's S3 settings:

| Key | Value |
|---|---|
| `WALG_S3_PREFIX` | `s3://<bucket>/pitr/<box name>-<YYYYMMDD>` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the key |
| `AWS_REGION` | the bucket's region; `auto` for Cloudflare R2 |
| `AWS_ENDPOINT` | S3-compatible storage only, e.g. `http://s3:9000` for the dev RustFS |
| `AWS_S3_FORCE_PATH_STYLE` | `true` if hattisar's "Force path style" is on |
| `WALG_COMPRESSION_METHOD` | `zstd` |
| `WALG_LIBSODIUM_KEY` | a fresh `openssl rand -hex 32` |
| `WALG_LIBSODIUM_KEY_TRANSFORM` | `hex` |
| `PGHOST`, `PGUSER`, `PGDATA` | `/var/run/postgresql`, `supabase_admin`, `/var/lib/postgresql/data` |
| `PGDATABASE` | `postgres` (managed boxes) |

WAL-G encrypts everything with the libsodium key before it leaves the box.

> **Lose `WALG_LIBSODIUM_KEY` and you lose every backup under the prefix.** Nothing can decrypt them
> without it. Keep a copy with `.env`, off the server.

## Managed boxes

A managed box takes no extra mounts or environment, so WAL-G and its config go into the container
with `docker cp`. They live in the container's own layer: they survive `docker restart`, stop and
start, and hattisar's own stop and start, but not a recreated container (see
[the disk-fill trap](#the-disk-fill-trap)). Repeat this section for each box.

### Enable archiving

Write `walg.yaml` with a fresh encryption key, then fill in the S3 values by hand:

```sh
(umask 077 && cat >walg.yaml <<EOF
WALG_S3_PREFIX: "s3://<bucket>/pitr/<name>-$(date -u +%Y%m%d)"
AWS_ACCESS_KEY_ID: "<access key id>"
AWS_SECRET_ACCESS_KEY: "<secret access key>"
AWS_REGION: "<region>"
AWS_ENDPOINT: "<endpoint, or delete this line for AWS S3>"
AWS_S3_FORCE_PATH_STYLE: "true"
WALG_COMPRESSION_METHOD: "zstd"
WALG_LIBSODIUM_KEY: "$(openssl rand -hex 32)"
WALG_LIBSODIUM_KEY_TRANSFORM: "hex"
PGHOST: "/var/run/postgresql"
PGUSER: "supabase_admin"
PGDATABASE: "postgres"
PGDATA: "/var/lib/postgresql/data"
EOF
)
```

`PGDATABASE` is required: without it `backup-push` tries the database `supabase_admin`, which does
not exist. Copy the binary and the config in, then turn archiving on:

```sh
docker cp walg/wal-g hattisar-box-<name>:/usr/local/bin/wal-g
docker exec -u root hattisar-box-<name> mkdir -p /etc/wal-g
docker cp walg.yaml hattisar-box-<name>:/etc/wal-g/walg.yaml
docker exec -u root hattisar-box-<name> sh -c "chown postgres:postgres /etc/wal-g/walg.yaml && chmod 600 /etc/wal-g/walg.yaml"
docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "alter system set archive_mode = on"
docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "alter system set archive_command = '/usr/local/bin/wal-g --config /etc/wal-g/walg.yaml wal-push %p'"
docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "alter system set archive_timeout = '60s'"
docker restart hattisar-box-<name>
```

`/etc/wal-g` does not exist in the image, so `docker cp` of the config fails without the `mkdir`.
`psql` needs `-d postgres` for the same reason as `PGDATABASE`. The settings go into
`postgresql.auto.conf` on the data volume, so they travel with the box's data.

A superuser on the box can read `walg.yaml`, S3 key included. Treat the box's admin access like
access to that key.

### First base backup

Take one right away; WAL alone cannot be restored without a base backup before it.

```sh
docker exec -u postgres hattisar-box-<name> /usr/local/bin/wal-g --config /etc/wal-g/walg.yaml backup-push /var/lib/postgresql/data
docker exec -u postgres hattisar-box-<name> /usr/local/bin/wal-g --config /etc/wal-g/walg.yaml backup-list
docker exec -u postgres hattisar-box-<name> /usr/local/bin/wal-g --config /etc/wal-g/walg.yaml wal-verify integrity
```

`wal-verify integrity` should end with `integrity check status: OK`.

### Daily backups and retention

A daily base backup keeps restores short, and `delete retain FULL 7` keeps the newest 7 with the
WAL they need. One host cron line per box (**untested**: the two commands are proven, the cron line
is not):

```
15 3 * * * docker exec -u postgres hattisar-box-<name> /usr/local/bin/wal-g --config /etc/wal-g/walg.yaml backup-push /var/lib/postgresql/data && docker exec -u postgres hattisar-box-<name> /usr/local/bin/wal-g --config /etc/wal-g/walg.yaml delete retain FULL 7 --confirm
```

### Check that archiving works

On a quiet box, write something first (any change in any database). `pg_switch_wal()` does nothing
on an empty segment, and you would wait for a segment that never closes. Then:

```sh
docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "select pg_walfile_name(pg_switch_wal())"
```

Within a minute, `last_archived_wal` in the check below should be that segment or a later one.

### Monitor it

Run this check from your monitoring, for every box:

```sh
docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "
select (select count(*) from pg_ls_archive_statusdir() where name like '%.ready') as pending,
       failed_count, last_failed_time, last_archived_wal, last_archived_time,
       now() - last_archived_time as archived_ago
from pg_stat_archiver"
```

- **`pending`** counts WAL segments waiting to be archived. It should be 0 or 1. If it grows,
  archiving is stuck, whatever `failed_count` says.
- **`failed_count`** and **`last_failed_time`** move when WAL-G runs and fails: S3 down, wrong keys,
  a broken `walg.yaml`. The box log says why.
- **`archived_ago`** should stay under a couple of minutes on a box that is being written to. On an
  idle box it grows, and that is fine.

The log shows failures too:

```sh
docker logs hattisar-box-<name> 2>&1 | grep 'archive command failed'
```

### The disk-fill trap

> **Recreating a managed box's container by hand loses WAL-G and fills the disk.** hattisar never
> recreates a managed container, but a hand recreation (for example to change its image) starts
> from the image again. The box's data still says `archive_mode = on`, so every archive attempt
> fails, and Postgres keeps every WAL segment until it succeeds. `pg_wal` grows until the disk is
> full.

A missing binary is the quiet case. The archive command exits 127, which Postgres treats as fatal:
the archiver process dies before it counts the failure and restarts about every 10 seconds.
**`failed_count` stays at 0.** Only `pending`, a stale `last_archived_time` and the log line
`archive command failed with exit code 127` show it. That is why the check above looks at all three.

Fix it by copying WAL-G and the config back in (the first four commands of
[Enable archiving](#enable-archiving)). The backlog drains within seconds. To stop archiving
instead (**untested**): `alter system reset archive_mode`, `alter system reset archive_command`,
then restart the box.

### Helper containers and purge

Run every helper on a box's volume with `--rm`, as below. hattisar's purge removes the box's
container and volume, and a leftover container on that volume makes it fail with `volume is in use`.
Purge does not touch the box's prefix in S3; delete it yourself when you no longer need it.

## The shared box

The shared box is for development only, so this section is too. The override
`compose.walg.yml` mounts the binary into `db` and loads `walg.env`.

Write `walg.env`, then fill in the S3 values:

```sh
(umask 077 && cat >walg.env <<EOF
WALG_S3_PREFIX=s3://<bucket>/pitr/shared-$(date -u +%Y%m%d)
AWS_ACCESS_KEY_ID=<access key id>
AWS_SECRET_ACCESS_KEY=<secret access key>
AWS_REGION=<region>
AWS_ENDPOINT=<endpoint, or delete this line for AWS S3>
AWS_S3_FORCE_PATH_STYLE=true
WALG_COMPRESSION_METHOD=zstd
WALG_LIBSODIUM_KEY=$(openssl rand -hex 32)
WALG_LIBSODIUM_KEY_TRANSFORM=hex
PGHOST=/var/run/postgresql
PGUSER=supabase_admin
PGDATA=/var/lib/postgresql/data
EOF
)
```

For the dev stack's RustFS: bucket `hattisar-test`, the `S3_TEST_*` keys from `docker/.env`, region
`us-east-1`, endpoint `http://s3:9000`.

The secrets reach `db` as environment, so `docker inspect hattisar-db-1` shows them. Anyone with
Docker access is root on the host anyway; keep `walg.env` at mode 600 and back it up with `.env`.

In a release directory, make the override the one compose loads by itself, and recreate `db` with
it. If you already have a `compose.override.yml`, merge the `db` part of `compose.walg.yml` into it
instead.

```sh
cp compose.walg.yml compose.override.yml
docker compose up -d db
```

In a checkout, every `docker compose` command in this file takes the dev stack's files plus the
override, from the checkout root:

```sh
docker compose -f docker/compose.yml -f docker/compose.dev.yml -f docker/compose.walg.yml \
  --profile s3-test --profile managed-boxes up -d db
```

Then turn archiving on, take the first base backup and check it:

```sh
docker exec -u postgres hattisar-db-1 psql -U supabase_admin -d postgres -c "alter system set archive_mode = on"
docker exec -u postgres hattisar-db-1 psql -U supabase_admin -d postgres -c "alter system set archive_command = '/usr/local/bin/wal-g wal-push %p'"
docker exec -u postgres hattisar-db-1 psql -U supabase_admin -d postgres -c "alter system set archive_timeout = '60s'"
docker compose restart db
docker exec -u postgres hattisar-db-1 /usr/local/bin/wal-g backup-push /var/lib/postgresql/data
docker exec -u postgres hattisar-db-1 /usr/local/bin/wal-g backup-list
docker exec -u postgres hattisar-db-1 /usr/local/bin/wal-g wal-verify integrity
```

WAL-G reads its settings from the environment here, so the shared box needs no `--config`. Daily
backups, the check and the monitoring query are the managed box's, with `hattisar-db-1` and without
`--config`. The disk-fill trap applies too: if the override goes away while `archive_mode` stays
on, archiving fails and `pg_wal` grows.

## Restore a box to a point in time

This replaces the box's data with its state at time T. Read it through once before you start.

**Pick T** in UTC, with the zone: `2026-10-25 09:30:00+00`. Postgres stops just before the first
commit after T.

**Pick the base backup** from `backup-list`: the newest one whose `modified` time is before T. Use
its name, for example `base_000000010000000000000002`. `LATEST` is right only while no backup newer
than T exists; after a restore and a new backup, it never is.

**Write `restore.sh`** next to `walg.yaml` with the backup name and T filled in. It runs in a
helper container: it empties the data dir, fetches the base backup and sets up recovery. For a
managed box:

```sh
set -eu
find /var/lib/postgresql/data -mindepth 1 -delete
/usr/local/bin/wal-g --config /etc/wal-g/walg.yaml backup-fetch /var/lib/postgresql/data <backup name>
cat >>/var/lib/postgresql/data/postgresql.auto.conf <<EOF
restore_command = '/usr/local/bin/wal-g --config /etc/wal-g/walg.yaml wal-fetch "%f" "%p"'
recovery_target_time = '<T>'
recovery_target_action = 'promote'
EOF
touch /var/lib/postgresql/data/recovery.signal
```

For the shared box, drop `--config /etc/wal-g/walg.yaml` from both WAL-G lines.

> **`recovery_target_action = 'promote'` is required.** The image sets `hot_standby = off`, which
> turns Postgres's default `pause` into `shutdown`. Without the line, the box replays to T and shuts
> down, `restart: unless-stopped` starts it again, and it replays and shuts down again: a restart
> loop, refusing connections throughout. To fix it, stop the box, add the line with the helper
> below (a `restore.sh` holding only
> `echo "recovery_target_action = 'promote'" >>/var/lib/postgresql/data/postgresql.auto.conf`),
> and start it again.

### Steps

The commands name a managed box. For the shared box, use `hattisar-db-1` in `docker exec` and
`docker logs`.

1. **Stop hattisar**, so its purge, scheduled dumps, pooler checks and Trash restore leave the box
   alone:

   ```sh
   docker compose stop hattisar
   ```

2. **Stop the box.** `unless-stopped` keeps a stopped container stopped.

   ```sh
   docker stop hattisar-box-<name>        # managed box
   docker compose stop db                 # shared box: Studio, postgres-meta and Supavisor lose it too
   ```

3. **Make a safety copy** of the data volume. It needs free disk about the size of the data.

   ```sh
   docker volume create box-<name>-before-pitr
   docker run --rm -v hattisar_box_<name>:/from:ro -v box-<name>-before-pitr:/to \
     --entrypoint sh supabase/postgres:17.6.1.136 -c 'cp -a /from/. /to/'
   ```

   For the shared box, copy `hattisar_db-data` into, say, `db-data-before-pitr`.

4. **Empty, fetch and configure** with `restore.sh`. For a managed box the helper runs on the box's
   network and volume. It starts as root, copies `walg.yaml` into its own layer owned by postgres
   (the mounted file is yours, mode 600, and postgres cannot read it), then drops to postgres:

   ```sh
   docker run --rm --network hattisar_default \
     -v hattisar_box_<name>:/var/lib/postgresql/data \
     -v "$PWD/walg/wal-g:/usr/local/bin/wal-g:ro" -v "$PWD/walg.yaml:/run/walg.yaml:ro" \
     --entrypoint sh supabase/postgres:17.6.1.136 -c \
     'install -d /etc/wal-g && install -o postgres -g postgres -m 600 /run/walg.yaml /etc/wal-g/walg.yaml && exec gosu postgres sh -c "$1"' \
     sh "$(cat restore.sh)"
   ```

   `hattisar_default` is the network the box runs on; in doubt,
   `docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' hattisar-box-<name>`
   prints it. For the shared box the helper is a one-off `db` with the override's mount and
   environment:

   ```sh
   docker compose run --rm -T --no-deps -u postgres --entrypoint sh db -c "$(cat restore.sh)"
   ```

   > **Never start the box on an emptied data dir.** The image's entrypoint would create a new,
   > empty cluster. If `restore.sh` fails, fix the cause and run it again (it empties the dir
   > first), or copy the safety copy back (**untested**):

   ```sh
   docker run --rm -v box-<name>-before-pitr:/from:ro -v hattisar_box_<name>:/to \
     --entrypoint sh supabase/postgres:17.6.1.136 -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/'
   ```

5. **Start the box.** It replays WAL up to T, then promotes onto a new timeline and removes
   `recovery.signal`. It refuses connections while it replays, so the shared box can read
   `unhealthy` for a while.

   ```sh
   docker start hattisar-box-<name>       # managed box
   docker compose start db                # shared box
   docker exec hattisar-box-<name> pg_isready -h localhost -U postgres
   docker logs hattisar-box-<name> 2>&1 | grep -E 'recovery stopping|selected new timeline|archive recovery complete'
   docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "select pg_is_in_recovery()"
   ```

   The log names the commit it stopped before and its time; `pg_is_in_recovery()` is `f`.

6. **Clean up** the recovery target, so a later restart does not try it again:

   ```sh
   docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "alter system reset recovery_target_time"
   docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "alter system reset recovery_target_action"
   docker exec -u postgres hattisar-box-<name> psql -U supabase_admin -d postgres -c "select pg_reload_conf()"
   ```

   The log may say these parameters cannot change without a restart. That is harmless: they apply
   only to a recovery.

7. **Take a new base backup** (the `backup-push` command above). Archiving carries on into the same
   prefix, on the new timeline.

8. **Start hattisar**, then go through [After a restore](#after-a-restore):

   ```sh
   docker compose start hattisar
   ```

Remove the safety copy (`docker volume rm box-<name>-before-pitr`) once you are happy.

**Restoring again** follows the latest timeline, the one the last restore created. Pick the base
backup by name, as above, and a T that the latest timeline reaches.

## After a restore

hattisar's registry lives in the `hattisar-data` volume, not on the box, so the restore does not
roll it back. Anything that changed on the box after T is now out of step with the registry:

| Happened after T | State now | Fix |
|---|---|---|
| Project created | Registry row active; database and owner role missing | Delete and purge it in hattisar; purge drops only what exists |
| Project purged | Database and role back on the box, unknown to hattisar | Drop them by hand (`drop database … with (force)`, `drop role`), or create a project and restore a dump into it |
| Project deleted to Trash | Registry says deleted; the box has the database under its original name, open to connect | Trash restore and purge both fail. Rename it by hand to the deleted name hattisar recorded and revoke CONNECT |
| Project restored from Trash | Registry active; the box has `<db>__deleted_<date>` | `alter database … rename` back and grant CONNECT again, by hand |
| Owner password rotated | The role has the old password; apps have the new one | Rotate it again in hattisar |
| hattisar restore of a dump into a project | Rolled back with everything else | Run it again if you want it |
| Pooler tenant created or re-created (managed box restore) | The `hattisar_pooler_*` role has its old password; Supavisor keeps the new one, so pooler logins fail | Delete the tenant in Supavisor; hattisar re-creates it within 10 minutes |
| Pooler tenant created (shared box restore) | Supavisor's own metadata rolled back too; the tenant is gone | Nothing: hattisar re-creates it within 10 minutes |
| Managed box created (shared box restore) | Unaffected: it has its own volume | — |
| hattisar backups in S3 | Unaffected | — |

## Getting back one project

PITR has no per-project restore. To get one project back to T without rolling back the rest of the
box, restore the box into a clone, dump the project's database from it and load that dump. **This
whole section is untested.**

1. Restore into a new volume, `pitr-clone`, with the restore steps 3 to 5 changed:
   - the box and hattisar keep running;
   - the helper mounts `pitr-clone` instead of the box's volume;
   - `restore.sh` adds `archive_mode = 'off'` to the recovery lines, so the clone never writes into
     the box's prefix.
2. Start a plain container on `pitr-clone` from `supabase/postgres:17.6.1.136`, with WAL-G and its
   config where `restore_command` expects them, and wait for it to promote.
3. `pg_dump -Fc` the project's database from the clone (its name is in the project's connection
   string).
4. Load it into a new project the way hattisar restores: `pg_restore --no-owner --no-privileges`
   with the new project's owner as `--role`. hattisar's own Restore takes only its own backups from
   S3, so this step is by hand.
5. Remove the clone's container and volume.

Vault-encrypted data in the clone of a managed box will not decrypt: the root key lives in the
original container, not the volume.

## What is not tested

`scripts/pitr-test.sh` proves the build, archiving, base backups, `wal-verify`, retention, a missing
binary, and restores of both box kinds, in throwaway Docker objects against RustFS. Not tested:

- the host cron line;
- real AWS S3 and Cloudflare R2 endpoints, and a key limited to `pitr/`;
- `docker compose stop hattisar` and `start hattisar` around a restore (the test runs no hattisar);
- the after-a-restore table, which comes from reading hattisar's code;
- copying the safety copy back, and turning archiving off;
- getting back one project through a clone.
