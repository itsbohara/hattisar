#!/bin/sh
# Writes docker/.env from docker/env.example with generated secrets. Never overwrites.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
target="$root/docker/.env"

if [ -f "$target" ]; then
  exit 0
fi

hex() {
  openssl rand -hex "$1"
}

umask 077
sed \
  -e "s|^HATTISAR_SECRET_KEY=.*|HATTISAR_SECRET_KEY=$(hex 32)|" \
  -e "s|^HATTISAR_ADMIN_PASSWORD=.*|HATTISAR_ADMIN_PASSWORD=$(hex 12)|" \
  -e "s|^PG_META_CRYPTO_KEY=.*|PG_META_CRYPTO_KEY=$(hex 32)|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
  -e "s|^POOLER_SECRET_KEY_BASE=.*|POOLER_SECRET_KEY_BASE=$(hex 48)|" \
  -e "s|^POOLER_VAULT_ENC_KEY=.*|POOLER_VAULT_ENC_KEY=$(hex 16)|" \
  -e "s|^POOLER_JWT_SECRET=.*|POOLER_JWT_SECRET=$(hex 32)|" \
  "$root/docker/env.example" >"$target"

echo "wrote docker/.env with generated secrets"
