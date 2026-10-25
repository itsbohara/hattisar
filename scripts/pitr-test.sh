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
  if [ -n "$tmp" ] && [ -f "$tmp/stack.env" ]; then
    compose down -v --remove-orphans >/dev/null 2>&1
  fi
  containers=$(docker ps -aq --filter "label=$label") || true
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086 # one id per word
    docker rm -f $containers >/dev/null
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

# Runs wal-g <args> in a throwaway container of the pinned postgres image.
walg_oneshot() {
  docker run --rm --label "$label" -v "$walg_bin:/usr/local/bin/wal-g:ro" \
    --entrypoint /usr/local/bin/wal-g "$pg_image" "$@"
}

build_walg() {
  log "building wal-g into docker/walg"
  docker build -q -f "$root/docker/wal-g/Dockerfile" -o "$root/docker/walg" "$root/docker/wal-g" >/dev/null
}

psql_in() {
  docker exec -u postgres "$1" psql -U supabase_admin -tAc "$2"
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

# Switches WAL and waits until the segment it closed is archived.
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
# leaves recovery_target_action unset.
restore_to() {
  helper=$1 backup=$2 target=$3 action_line=
  if [ -n "$4" ]; then
    action_line="recovery_target_action = '$4'"
  fi
  "$helper" "set -eu
find $pgdata -mindepth 1 -delete
/usr/local/bin/wal-g backup-fetch $pgdata $backup
cat >>$pgdata/postgresql.auto.conf <<EOF
restore_command = '/usr/local/bin/wal-g wal-fetch \"%f\" \"%p\"'
recovery_target_time = '$target'
$action_line
EOF
touch $pgdata/recovery.signal"
}

shared_helper() {
  compose run --rm -T --no-deps -u postgres --entrypoint sh db -c "$1"
}

# Copies the shared box's data volume into a fresh labelled volume before a restore empties it.
safety_copy() {
  docker volume rm "$label-safety" >/dev/null 2>&1 || true
  docker volume create --label "$label" "$label-safety" >/dev/null
  docker run --rm --label "$label" -v "${label}_db-data:/from:ro" -v "$label-safety:/to" \
    --entrypoint sh "$pg_image" -c 'cp -a /from/. /to/'
}

recovery_log() {
  docker logs "$1" 2>&1 | grep -E 'starting point-in-time recovery|recovery stopping|selected new timeline|archive recovery complete|shutdown at recovery target' || true
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
  backup=$(printf '%s\n' "$backups" | awk '$1 ~ /^base_/ { print $1 }')
  [ "$(printf '%s\n' "$backup" | grep -c .)" -eq 1 ] || fail "expected one backup, got: $backups"
  integrity=$(walg_in "$db" wal-verify integrity 2>&1)
  printf '%s\n' "$integrity"
  printf '%s\n' "$integrity" | grep -q 'integrity check status: OK' || fail "wal-verify integrity is not OK"

  log "shared box: restoring $backup to $target"
  compose stop db
  safety_copy
  restore_to shared_helper "$backup" "$target" promote
  compose start db
  wait_ready "$db"
  rows=$(psql_in "$db" "select string_agg(v::text, ',' order by v) from pitr_t")
  [ "$rows" = 1,2 ] || fail "expected rows 1,2 after restore, got: $rows"
  [ "$(psql_in "$db" 'select pg_is_in_recovery()')" = f ] || fail "still in recovery"
  if docker exec "$db" test -e "$pgdata/recovery.signal"; then
    fail "recovery.signal still present"
  fi
  psql_in "$db" checkpoint >/dev/null
  timeline=$(psql_in "$db" 'select timeline_id from pg_control_checkpoint()')
  [ "$timeline" = 2 ] || fail "expected timeline 2, got: $timeline"
  recovery_log "$db"
  log "restored rows $rows on timeline $timeline"
  psql_in "$db" 'alter system reset recovery_target_time' >/dev/null
  psql_in "$db" 'alter system reset recovery_target_action' >/dev/null
  psql_in "$db" 'select pg_reload_conf()' >/dev/null
  walg_in "$db" backup-push "$pgdata"
  # A commit after the target on the new timeline, so the next recovery, which follows the latest
  # timeline, meets one and stops instead of running out of WAL short of the target.
  psql_in "$db" 'insert into pitr_t values (4)' >/dev/null
  wait_archived "$db"

  log "shared box: restoring $backup again with recovery_target_action unset"
  compose stop db
  safety_copy
  restore_to shared_helper "$backup" "$target" ""
  shutdowns=$(docker logs "$db" 2>&1 | grep -c 'shutdown at recovery target') || true
  compose start db
  i=0
  until [ "$(docker logs "$db" 2>&1 | grep -c 'shutdown at recovery target')" -gt "$shutdowns" ]; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "no 'shutdown at recovery target' within 60 s"
    sleep 1
  done
  if docker exec "$db" pg_isready -q -h localhost -U postgres 2>/dev/null; then
    fail "server accepts connections after reaching the target with action unset"
  fi
  sleep 5
  log "after the target: $(docker inspect -f '{{.State.Status}}, restarts {{.RestartCount}}' "$db")"
  docker logs "$db" 2>&1 | grep -E -B2 'shutdown at recovery target' | tail -n 6
  compose stop db

  log "shared box: fixing it with recovery_target_action = 'promote'"
  shared_helper "echo \"recovery_target_action = 'promote'\" >>$pgdata/postgresql.auto.conf"
  compose start db
  wait_ready "$db"
  rows=$(psql_in "$db" "select string_agg(v::text, ',' order by v) from pitr_t")
  [ "$rows" = 1,2 ] || fail "expected rows 1,2 after the promote fix, got: $rows"
  psql_in "$db" checkpoint >/dev/null
  log "restored rows $rows on timeline $(psql_in "$db" 'select timeline_id from pg_control_checkpoint()')"
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  [ ! -e "$walg_env" ] || fail "$walg_env exists; move it aside first"
  step0_image_has_no_walg
  step1_walg_runs
  pitr_shared
  log "ok"
}

main
