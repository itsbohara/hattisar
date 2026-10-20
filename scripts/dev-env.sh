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

if [ ! -f "$target" ]; then
  sed \
    -e "s|^HATTISAR_SECRET_KEY=.*|HATTISAR_SECRET_KEY=$(hex 32)|" \
    -e "s|^HATTISAR_ADMIN_PASSWORD=.*|HATTISAR_ADMIN_PASSWORD=$(hex 12)|" \
    -e "s|^PG_META_CRYPTO_KEY=.*|PG_META_CRYPTO_KEY=$(hex 32)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
    -e "s|^POOLER_SECRET_KEY_BASE=.*|POOLER_SECRET_KEY_BASE=$(hex 48)|" \
    -e "s|^POOLER_VAULT_ENC_KEY=.*|POOLER_VAULT_ENC_KEY=$(hex 16)|" \
    -e "s|^POOLER_JWT_SECRET=.*|POOLER_JWT_SECRET=$(hex 32)|" \
    -e "s|^S3_TEST_ACCESS_KEY=.*|S3_TEST_ACCESS_KEY=$(hex 10)|" \
    -e "s|^S3_TEST_SECRET_KEY=.*|S3_TEST_SECRET_KEY=$(hex 20)|" \
    "$root/docker/env.example" >"$target"
  echo "wrote docker/.env with generated secrets"
fi

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
