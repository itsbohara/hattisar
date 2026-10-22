#!/bin/sh
# Writes <target> from <template> with every secret freshly generated. On an existing <target>,
# appends each key the template has and the target lacks, and never changes an existing line.
set -eu

if [ $# -ne 2 ]; then
  echo "usage: sh generate-env.sh <template> <target>" >&2
  exit 2
fi

template=$1
target=$2

secret_bytes='HATTISAR_SECRET_KEY 32
HATTISAR_ADMIN_PASSWORD 12
PG_META_CRYPTO_KEY 32
POSTGRES_PASSWORD 24
POOLER_SECRET_KEY_BASE 48
POOLER_VAULT_ENC_KEY 16
POOLER_JWT_SECRET 32
S3_TEST_ACCESS_KEY 10
S3_TEST_SECRET_KEY 20'

hex() {
  openssl rand -hex "$1"
}

# Prints the key of a `KEY=value` line; prints nothing for comments, blanks and anything else.
key_of() {
  case $1 in
    [A-Za-z_]*=*) ;;
    *) return 0 ;;
  esac
  key=${1%%=*}
  case $key in
    *[!A-Za-z0-9_]*) ;;
    *) printf '%s\n' "$key" ;;
  esac
}

# Prints the line for <key>: a fresh secret if <key> is one, else the template's <line>.
line_for() {
  bytes=$(printf '%s\n' "$secret_bytes" | while read -r name n; do
    if [ "$name" = "$1" ]; then printf '%s\n' "$n"; fi
  done)
  if [ -n "$bytes" ]; then
    printf '%s=%s\n' "$1" "$(hex "$bytes")"
  else
    printf '%s\n' "$2"
  fi
}

umask 077

if [ ! -f "$target" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    key=$(key_of "$line")
    if [ -n "$key" ]; then
      line_for "$key" "$line"
    else
      printf '%s\n' "$line"
    fi
  done <"$template" >"$target"
  echo "wrote $target with generated secrets"
  exit 0
fi

while IFS= read -r line || [ -n "$line" ]; do
  key=$(key_of "$line")
  [ -n "$key" ] || continue
  grep -q "^$key=" "$target" && continue
  # Without this, the first appended key would join a last line that has no newline.
  if [ -s "$target" ] && [ -n "$(tail -c 1 "$target")" ]; then
    echo >>"$target"
  fi
  line_for "$key" "$line" >>"$target"
  echo "added $key to $target"
done <"$template"
