#!/bin/sh
# Packs the compose bundle for a server release: <out-dir>/hattisar-<version>.tar.gz, unpacking to
# hattisar/ with the image default pinned to <version>. Prints the tarball path.
set -eu

if [ $# -ne 2 ]; then
  echo "usage: sh scripts/release-bundle.sh <version> <out-dir>" >&2
  exit 2
fi

version=$1
out_dir=$2

valid_version() {
  # The charset check also rejects newlines, which grep would otherwise match line by line.
  case $1 in *[!0-9A-Za-z.-]*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

if ! valid_version "$version"; then
  echo "release-bundle: version must look like 1.2.3, got $version" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

bundle="$stage/hattisar"
mkdir -p "$bundle/volumes/db" "$bundle/volumes/pooler" "$bundle/volumes/caddy"

pinned="image: ghcr.io/itsbohara/hattisar:\${HATTISAR_VERSION:-$version}"
sed "s|image: ghcr\.io/itsbohara/hattisar:\${HATTISAR_VERSION:-latest}|$pinned|" \
  "$root/docker/compose.yml" >"$bundle/compose.yml"

if [ "$(grep -cF "$pinned" "$bundle/compose.yml")" -ne 1 ]; then
  echo "release-bundle: expected one '$pinned' line in compose.yml" >&2
  exit 1
fi

cp "$root/docker/env.example" "$root/docker/NOTICE" "$root/scripts/generate-env.sh" "$bundle/"
cp "$root/docker/volumes/db/roles.sql" "$root/docker/volumes/db/_supabase.sql" \
  "$root/docker/volumes/db/pooler.sql" "$bundle/volumes/db/"
cp "$root/docker/volumes/pooler/pooler.exs" "$bundle/volumes/pooler/"
cp "$root/docker/volumes/caddy/Caddyfile" "$bundle/volumes/caddy/"

tarball="$out_dir/hattisar-$version.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$tarball" -C "$stage" hattisar
echo "$tarball"
