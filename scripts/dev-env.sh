#!/bin/sh
# Writes docker/.env from docker/env.example with generated secrets. Never overwrites a value:
# keys added to env.example after docker/.env was written are appended with fresh secrets.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
target="$root/docker/.env"

hex() {
  openssl rand -hex "$1"
}

umask 077

(cd "$root" && sh scripts/generate-env.sh docker/env.example docker/.env)

if ! grep -q '^S3_TEST_ACCESS_KEY=' "$target"; then
  {
    echo
    echo "# --- S3-compatible test service (compose profile s3-test; local dev and tests only) ---"
    echo "S3_TEST_ACCESS_KEY=$(hex 10)"
    echo "S3_TEST_SECRET_KEY=$(hex 20)"
    echo "S3_TEST_BUCKET=hattisar-test"
  } >>"$target"
  echo "added S3 test credentials to docker/.env"
fi
