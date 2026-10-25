#!/bin/sh
# Proves the WAL-G PITR recipe in throwaway Docker objects: compose project hattisar-pitr-test and
# objects labelled or named hattisar-pitr-test, removed on exit. Never touches the hattisar compose
# project and never reads docker/.env.
#   sh scripts/pitr-test.sh
set -eu

pg_image=supabase/postgres:17.6.1.136
walg_version=3.0.9
label=hattisar-pitr-test
pgdata=/var/lib/postgresql/data
box=$label-box
walg_conf=/etc/wal-g/walg.yaml

root=$(cd "$(dirname "$0")/.." && pwd)
walg_bin="$root/docker/walg/wal-g"
walg_env="$root/docker/walg.env"
wrote_walg_env=
tmp=

log() {
  echo "pitr-test: $*"
}

fail() {
  echo "pitr-test: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  set +e
  # Labelled containers go first: the managed box sits on the compose network, and compose down
  # cannot remove a network that still has a container attached.
  containers=$(docker ps -aq --filter "label=$label") || true
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086 # one id per word
    docker rm -f $containers >/dev/null
  fi
  if [ -n "$tmp" ] && [ -f "$tmp/stack.env" ]; then
    compose down -v --remove-orphans >/dev/null 2>&1
  fi
  volumes=$(docker volume ls -q --filter "label=$label") || true
  if [ -n "$volumes" ]; then
    # shellcheck disable=SC2086 # one name per word
    docker volume rm $volumes >/dev/null
  fi
  if [ -n "$wrote_walg_env" ]; then
    rm -f "$walg_env"
  fi
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
  exit "$status"
}

# The shared box's compose files plus the WAL-G override, under the throwaway project. The explicit
# --env-file keeps compose from reading docker/.env.
compose() {
  docker compose -p "$label" --env-file "$tmp/stack.env" --profile s3-test \
    -f "$root/docker/compose.yml" -f "$root/docker/compose.dev.yml" \
    -f "$root/docker/compose.walg.yml" "$@"
}

walg_oneshot() {
  docker run --rm --label "$label" -v "$walg_bin:/usr/local/bin/wal-g:ro" \
    --entrypoint /usr/local/bin/wal-g "$pg_image" "$@"
}

build_walg() {
  log "building wal-g into docker/walg"
  docker build -q -f "$root/docker/wal-g/Dockerfile" -o "$root/docker/walg" "$root/docker/wal-g" >/dev/null
}

psql_in() {
  docker exec -u postgres "$1" psql -U supabase_admin -d postgres -tAc "$2"
}

walg_in() {
  container=$1
  shift
  docker exec -u postgres "$container" /usr/local/bin/wal-g "$@"
}

# Waits until <container> accepts connections; during recovery it refuses them (hot_standby off).
wait_ready() {
  i=0
  until docker exec "$1" pg_isready -q -h localhost -U postgres 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 120 ] || fail "$1 not accepting connections after 120 s"
    sleep 1
  done
}

wait_archived() {
  seg=$(psql_in "$1" 'select pg_walfile_name(pg_switch_wal())')
  case $seg in
    "" | *[!0-9A-F]*) fail "unexpected WAL segment name: $seg" ;;
  esac
  i=0
  until [ "$(psql_in "$1" "select coalesce(last_archived_wal >= '$seg', false) from pg_stat_archiver")" = t ]; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      fail "$seg not archived after 60 s: $(psql_in "$1" 'select failed_count, last_failed_wal from pg_stat_archiver')"
    fi
    sleep 1
  done
  log "archived $seg"
}

# Refills the stopped box's data dir from <backup> and sets it to recover to <target time>.
# <helper> is a function that runs its argument as a sh script, as user postgres, in a container
# with the box's data volume, wal-g and its config, and never the box itself. An empty <action>
# leaves recovery_target_action unset. <walg> is the wal-g command, with --config if the box needs it.
restore_to() {
  helper=$1 backup=$2 target=$3 walg=${5:-/usr/local/bin/wal-g} action_line=
  if [ -n "$4" ]; then
    action_line="recovery_target_action = '$4'"
  fi
  "$helper" "set -eu
find $pgdata -mindepth 1 -delete
$walg backup-fetch $pgdata $backup
cat >>$pgdata/postgresql.auto.conf <<EOF
restore_command = '$walg wal-fetch \"%f\" \"%p\"'
recovery_target_time = '$target'
$action_line
EOF
touch $pgdata/recovery.signal"
}

shared_helper() {
  compose run --rm -T --no-deps -u postgres --entrypoint sh db -c "$1"
}

safety_copy() {
  docker volume rm "$label-safety" >/dev/null 2>&1 || true
  docker volume create --label "$label" "$label-safety" >/dev/null
  docker run --rm --label "$label" -v "$1:/from:ro" -v "$label-safety:/to" \
    --entrypoint sh "$pg_image" -c 'cp -a /from/. /to/'
}

recovery_log() {
  docker logs "$1" 2>&1 | grep -E 'starting point-in-time recovery|recovery stopping|selected new timeline|archive recovery complete|shutdown at recovery target' || true
}

# Asserts the restored <container> holds rows 1,2, is out of recovery and is on <timeline>.
assert_restored() {
  rows=$(psql_in "$1" "select string_agg(v::text, ',' order by v) from pitr_t")
  [ "$rows" = 1,2 ] || fail "expected rows 1,2 after restore, got: $rows"
  [ "$(psql_in "$1" 'select pg_is_in_recovery()')" = f ] || fail "still in recovery"
  if docker exec "$1" test -e "$pgdata/recovery.signal"; then
    fail "recovery.signal still present"
  fi
  psql_in "$1" checkpoint >/dev/null
  timeline=$(psql_in "$1" 'select timeline_id from pg_control_checkpoint()')
  [ "$timeline" = "$2" ] || fail "expected timeline $2, got: $timeline"
  recovery_log "$1"
  docker logs "$1" 2>&1 | grep -q 'recovery stopping before commit' || fail "no 'recovery stopping before commit' in the log"
  log "restored rows $rows on timeline $timeline"
}

reset_recovery_target() {
  psql_in "$1" 'alter system reset recovery_target_time' >/dev/null
  psql_in "$1" 'alter system reset recovery_target_action' >/dev/null
  psql_in "$1" 'select pg_reload_conf()' >/dev/null
}

# Prints the base_ backup names in <backup-list output>, one per line.
backup_names() {
  printf '%s\n' "$1" | awk '$1 ~ /^base_/ { print $1 }'
}

write_env_files() {
  tmp=$(mktemp -d)
  sh "$root/scripts/generate-env.sh" "$root/docker/env.example" "$tmp/stack.env" >/dev/null
  access=$(sed -n 's/^S3_TEST_ACCESS_KEY=//p' "$tmp/stack.env")
  secret=$(sed -n 's/^S3_TEST_SECRET_KEY=//p' "$tmp/stack.env")
  bucket=$(sed -n 's/^S3_TEST_BUCKET=//p' "$tmp/stack.env")
  sodium=$(openssl rand -hex 32)
  # noclobber makes the create fail, not overwrite, if an operator's walg.env appeared meanwhile.
  (umask 077 && set -C && : >"$walg_env") || fail "$walg_env exists; move it aside first"
  wrote_walg_env=1
  cat >"$walg_env" <<EOF
WALG_S3_PREFIX=s3://$bucket/pitr/test-$(date -u +%Y%m%d)
AWS_ACCESS_KEY_ID=$access
AWS_SECRET_ACCESS_KEY=$secret
AWS_REGION=us-east-1
AWS_ENDPOINT=http://s3:9000
AWS_S3_FORCE_PATH_STYLE=true
WALG_COMPRESSION_METHOD=zstd
WALG_LIBSODIUM_KEY=$sodium
WALG_LIBSODIUM_KEY_TRANSFORM=hex
PGHOST=/var/run/postgresql
PGUSER=supabase_admin
PGDATA=$pgdata
EOF
}

step0_image_has_no_walg() {
  log "step 0: $pg_image ships no wal-g"
  found=$(docker run --rm --label "$label" --entrypoint sh "$pg_image" -c 'command -v wal-g || echo none')
  [ "$found" = none ] || fail "$pg_image now ships wal-g at $found; revisit the PITR recipe"
}

step1_walg_runs() {
  log "step 1: wal-g runs in $pg_image"
  build_walg
  version=$(walg_oneshot --version)
  log "$version"
  case $version in
    *"$walg_version"*) ;;
    *) fail "expected wal-g $walg_version, got: $version" ;;
  esac
}

pitr_shared() {
  log "shared box: starting db and s3 under project $label"
  write_env_files
  compose up -d --wait db s3
  compose run --rm s3-bucket
  db=$(compose ps -q db)

  log "shared box: enabling archiving"
  psql_in "$db" "alter system set archive_mode = on" >/dev/null
  psql_in "$db" "alter system set archive_command = '/usr/local/bin/wal-g wal-push %p'" >/dev/null
  psql_in "$db" "alter system set archive_timeout = '60s'" >/dev/null
  compose restart db
  wait_ready "$db"
  [ "$(psql_in "$db" 'show archive_mode')" = on ] || fail "archive_mode is not on after restart"

  log "shared box: base backup and writes"
  psql_in "$db" 'create table pitr_t(v int); insert into pitr_t values (1)' >/dev/null
  walg_in "$db" backup-push "$pgdata"
  psql_in "$db" 'insert into pitr_t values (2)' >/dev/null
  psql_in "$db" 'select pg_switch_wal()' >/dev/null
  target=$(psql_in "$db" "select to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
  log "target time $target"
  sleep 2
  psql_in "$db" 'insert into pitr_t values (3)' >/dev/null
  wait_archived "$db"

  backups=$(walg_in "$db" backup-list)
  printf '%s\n' "$backups"
  backup=$(backup_names "$backups")
  [ "$(printf '%s\n' "$backup" | grep -c .)" -eq 1 ] || fail "expected one backup, got: $backups"
  integrity=$(walg_in "$db" wal-verify integrity 2>&1)
  printf '%s\n' "$integrity"
  printf '%s\n' "$integrity" | grep -q 'integrity check status: OK' || fail "wal-verify integrity is not OK"

  log "shared box: restoring $backup to $target"
  compose stop db
  safety_copy "${label}_db-data"
  restore_to shared_helper "$backup" "$target" promote
  compose start db
  wait_ready "$db"
  assert_restored "$db" 2
  reset_recovery_target "$db"
  walg_in "$db" backup-push "$pgdata"
  # A commit after the target on the new timeline, so the next recovery, which follows the latest
  # timeline, meets one and stops instead of running out of WAL short of the target.
  psql_in "$db" 'insert into pitr_t values (4)' >/dev/null
  wait_archived "$db"

  log "shared box: restoring $backup again with recovery_target_action unset"
  compose stop db
  safety_copy "${label}_db-data"
  restore_to shared_helper "$backup" "$target" ""
  shutdowns=$(docker logs "$db" 2>&1 | grep -c 'shutdown at recovery target') || true
  compose start db
  i=0
  until [ "$(docker logs "$db" 2>&1 | grep -c 'shutdown at recovery target')" -gt "$shutdowns" ]; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "no 'shutdown at recovery target' within 60 s"
    sleep 1
  done
  sleep 5
  log "after the target: $(docker inspect -f '{{.State.Status}}, restarts {{.RestartCount}}' "$db")"
  docker logs "$db" 2>&1 | grep -E -B2 'shutdown at recovery target' | tail -n 6
  compose stop db

  log "shared box: fixing it with recovery_target_action = 'promote'"
  shared_helper "echo \"recovery_target_action = 'promote'\" >>$pgdata/postgresql.auto.conf"
  compose start db
  wait_ready "$db"
  assert_restored "$db" 3
}

box_walg() {
  walg_in "$box" --config "$walg_conf" "$@"
}

# A managed box has no env file: wal-g reads every setting from walg.yaml in its container layer.
write_walg_yaml() {
  (umask 077 && cat >"$tmp/walg.yaml") <<EOF
WALG_S3_PREFIX: "s3://$bucket/pitr/test-box-$(date -u +%Y%m%d)"
AWS_ACCESS_KEY_ID: "$access"
AWS_SECRET_ACCESS_KEY: "$secret"
AWS_REGION: "us-east-1"
AWS_ENDPOINT: "http://s3:9000"
AWS_S3_FORCE_PATH_STYLE: "true"
WALG_COMPRESSION_METHOD: "zstd"
WALG_LIBSODIUM_KEY: "$sodium"
WALG_LIBSODIUM_KEY_TRANSFORM: "hex"
PGHOST: "/var/run/postgresql"
PGUSER: "supabase_admin"
PGDATABASE: "postgres"
PGDATA: "$pgdata"
EOF
}

# Postgres cannot read the bind-mounted walg.yaml (mode 600, owned by the host user), so the helper
# starts as root, installs a postgres-owned copy in its own layer and drops to postgres.
managed_helper() {
  docker run --rm --label "$label" --network "$net" \
    -v "$box:$pgdata" -v "$walg_bin:/usr/local/bin/wal-g:ro" -v "$tmp/walg.yaml:/run/walg.yaml:ro" \
    --entrypoint sh "$pg_image" -c \
    'install -d /etc/wal-g && install -o postgres -g postgres -m 600 /run/walg.yaml /etc/wal-g/walg.yaml && exec gosu postgres sh -c "$1"' \
    sh "$1"
}

pitr_managed() {
  net=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$(compose ps -q s3)")
  log "managed box: starting $box on network $net"
  (umask 077 && printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" >"$tmp/box.env")
  write_walg_yaml
  docker volume create --label "$label" "$box" >/dev/null
  docker run -d --name "$box" --label "$label" --env-file "$tmp/box.env" \
    -v "$box:$pgdata" --restart unless-stopped --network "$net" "$pg_image" >/dev/null
  wait_ready "$box"

  log "managed box: copying wal-g and walg.yaml in, enabling archiving"
  docker cp -q "$walg_bin" "$box:/usr/local/bin/wal-g"
  docker exec -u root "$box" mkdir -p /etc/wal-g
  docker cp -q "$tmp/walg.yaml" "$box:$walg_conf"
  docker exec -u root "$box" sh -c "chown postgres:postgres $walg_conf && chmod 600 $walg_conf"
  psql_in "$box" "alter system set archive_mode = on" >/dev/null
  psql_in "$box" "alter system set archive_command = '/usr/local/bin/wal-g --config $walg_conf wal-push %p'" >/dev/null
  psql_in "$box" "alter system set archive_timeout = '60s'" >/dev/null
  docker restart "$box" >/dev/null
  wait_ready "$box"
  [ "$(psql_in "$box" 'show archive_mode')" = on ] || fail "archive_mode is not on after restart"

  log "managed box: base backup, stop/start, writes"
  psql_in "$box" 'create table pitr_t(v int); insert into pitr_t values (1)' >/dev/null
  box_walg backup-push "$pgdata"
  docker stop "$box" >/dev/null
  docker start "$box" >/dev/null
  wait_ready "$box"
  psql_in "$box" 'insert into pitr_t values (2)' >/dev/null
  psql_in "$box" 'select pg_switch_wal()' >/dev/null
  target=$(psql_in "$box" "select to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
  log "target time $target"
  sleep 2
  psql_in "$box" 'insert into pitr_t values (3)' >/dev/null
  wait_archived "$box"

  backups=$(box_walg backup-list)
  printf '%s\n' "$backups"
  backup=$(backup_names "$backups")
  [ "$(printf '%s\n' "$backup" | grep -c .)" -eq 1 ] || fail "expected one backup, got: $backups"
  integrity=$(box_walg wal-verify integrity 2>&1)
  printf '%s\n' "$integrity"
  printf '%s\n' "$integrity" | grep -q 'integrity check status: OK' || fail "wal-verify integrity is not OK"

  log "managed box: restoring $backup to $target"
  docker stop "$box" >/dev/null
  safety_copy "$box"
  restore_to managed_helper "$backup" "$target" promote "/usr/local/bin/wal-g --config $walg_conf"
  docker start "$box" >/dev/null
  wait_ready "$box"
  assert_restored "$box" 2
  reset_recovery_target "$box"
}

retention() {
  log "retention: second base backup, then delete retain FULL 1"
  box_walg backup-push "$pgdata"
  [ "$(backup_names "$(box_walg backup-list)" | grep -c .)" -eq 2 ] || fail "expected two backups before retention"
  box_walg delete retain FULL 1 --confirm
  backups=$(box_walg backup-list)
  printf '%s\n' "$backups"
  [ "$(backup_names "$backups" | grep -c .)" -eq 1 ] || fail "expected one backup after retention, got: $backups"
}

archive_pending() {
  psql_in "$box" "select count(*) from pg_ls_archive_statusdir() where name like '%.ready'"
}

failed_count() {
  psql_in "$box" 'select failed_count from pg_stat_archiver'
}

# A missing binary makes archive_command exit 127, which Postgres treats as fatal: the archiver
# exits before it counts the failure, so failed_count stays put while WAL piles up in pg_wal. Only
# the pending .ready files and the log show it. A wal-g that runs and fails is counted.
archive_failure() {
  log "archive failure: removing wal-g from $box"
  before=$(failed_count)
  docker exec -u root "$box" rm /usr/local/bin/wal-g
  psql_in "$box" 'insert into pitr_t select generate_series(10, 1000)' >/dev/null
  psql_in "$box" 'select pg_switch_wal()' >/dev/null
  i=0
  until docker logs "$box" 2>&1 | grep -q 'archive command failed with exit code 127'; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "no 'archive command failed with exit code 127' within 30 s"
    sleep 1
  done
  pending=$(archive_pending)
  [ "$pending" -gt 0 ] || fail "expected WAL segments waiting to be archived, got: $pending"
  [ "$(failed_count)" = "$before" ] || fail "failed_count moved with wal-g missing; the docs' check needs revisiting"
  log "wal-g missing: $pending segment(s) pending, failed_count still $before"

  log "archive failure: wal-g back, walg.yaml moved away"
  docker exec -u root "$box" mv "$walg_conf" "$walg_conf.off"
  docker cp -q "$walg_bin" "$box:/usr/local/bin/wal-g"
  i=0
  until [ "$(failed_count)" -gt "$before" ]; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "failed_count did not rise within 30 s"
    sleep 1
  done
  log "failed_count $before -> $(psql_in "$box" "select failed_count || ', last_failed_wal ' || last_failed_wal || ', last_failed_time ' || last_failed_time from pg_stat_archiver")"

  log "archive failure: walg.yaml back"
  docker exec -u root "$box" mv "$walg_conf.off" "$walg_conf"
  i=0
  until [ "$(archive_pending)" = 0 ]; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "pending segments not archived within 30 s of the fix"
    sleep 1
  done
  # pg_switch_wal does nothing on a segment with no WAL in it, and wait_archived would then wait
  # for a segment that never closes.
  psql_in "$box" 'insert into pitr_t values (5)' >/dev/null
  wait_archived "$box"
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  [ ! -e "$walg_env" ] || fail "$walg_env exists; move it aside first"
  step0_image_has_no_walg
  step1_walg_runs
  pitr_shared
  pitr_managed
  retention
  archive_failure
  log "ok"
}

main
