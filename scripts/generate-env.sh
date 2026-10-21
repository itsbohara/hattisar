#!/bin/sh
# Writes <target> from <template> with every secret freshly generated. Never touches an existing
# <target>.
set -eu

if [ $# -ne 2 ]; then
  echo "usage: sh generate-env.sh <template> <target>" >&2
  exit 2
fi

template=$1
target=$2

[ -f "$target" ] && exit 0

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
  -e "s|^S3_TEST_ACCESS_KEY=.*|S3_TEST_ACCESS_KEY=$(hex 10)|" \
  -e "s|^S3_TEST_SECRET_KEY=.*|S3_TEST_SECRET_KEY=$(hex 20)|" \
  "$template" >"$target"
echo "wrote $target with generated secrets"
