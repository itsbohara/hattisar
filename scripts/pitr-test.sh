#!/bin/sh
# Proves the WAL-G PITR recipe in throwaway Docker objects labelled hattisar-pitr-test, removed on
# exit. Never touches the hattisar compose project.
#   sh scripts/pitr-test.sh
set -eu

pg_image=supabase/postgres:17.6.1.136
walg_version=3.0.9
label=hattisar-pitr-test

root=$(cd "$(dirname "$0")/.." && pwd)
walg_bin="$root/docker/walg/wal-g"

log() {
  echo "pitr-test: $*"
}

fail() {
  echo "pitr-test: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  containers=$(docker ps -aq --filter "label=$label")
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086 # one id per word
    docker rm -f $containers >/dev/null
  fi
  exit "$status"
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

step0_image_has_no_walg() {
  log "step 0: $pg_image ships no wal-g"
  if docker run --rm --label "$label" --entrypoint sh "$pg_image" -c 'command -v wal-g' >/dev/null; then
    fail "$pg_image now ships wal-g; revisit the PITR recipe"
  fi
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

main() {
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  step0_image_has_no_walg
  step1_walg_runs
  log "ok"
}

main
