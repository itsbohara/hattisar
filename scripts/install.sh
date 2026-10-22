#!/bin/sh
# Installs hattisar from a release bundle into a directory, or upgrades the install already there.
#   curl -fsSL https://github.com/itsbohara/hattisar/releases/latest/download/install.sh | sudo sh
# Options: --dir <path> --version <x.y.z> --domain <name> | --no-domain
#          --managed-boxes | --no-managed-boxes --yes

usage_error() {
  echo "install: $1" >&2
  exit 2
}

fail() {
  echo "install: $1" >&2
  exit 1
}

valid_version() {
  # The charset check also rejects newlines, which grep would otherwise match line by line.
  case $1 in *[!0-9A-Za-z.-]*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

valid_domain() {
  case $1 in *[!0-9A-Za-z.-]*) return 1 ;; esac
  printf '%s\n' "$1" |
    grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
}

# Opening /dev/tty fails at once, rather than blocking, when there is no controlling terminal.
has_tty() {
  (exec </dev/tty) 2>/dev/null
}

ask_domain() {
  while :; do
    printf '%s' 'Domain for hattisar (empty: localhost only): ' >/dev/tty
    IFS= read -r answer </dev/tty || usage_error "no answer for the domain; pass --domain <name> or --no-domain"
    if [ -z "$answer" ] || valid_domain "$answer"; then
      domain=$answer
      return 0
    fi
    echo "Not a domain name: $answer" >/dev/tty
  done
}

ask_managed_boxes() {
  while :; do
    printf '%s' 'Enable managed boxes? hattisar reaches Docker through a socket proxy to run Postgres containers. [Y/n] ' >/dev/tty
    IFS= read -r answer </dev/tty ||
      usage_error "no answer for managed boxes; pass --managed-boxes or --no-managed-boxes"
    case $answer in
      '' | y | Y | yes | Yes | YES) managed_boxes=true && return 0 ;;
      n | N | no | No | NO) managed_boxes=false && return 0 ;;
    esac
  done
}

# Prints the value of <key> in the .env at <file>.
env_value() {
  sed -n "s/^$1=//p" "$2" | tail -n 1
}

# Sets <key>=<value> in the .env at <file>, replacing the key's line in place or appending one.
set_env() {
  tmp_env=$(mktemp "$1.XXXXXX")
  KEY=$2 VALUE=$3 awk '
    BEGIN { key = ENVIRON["KEY"]; line = key "=" ENVIRON["VALUE"] }
    index($0, key "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$1" >"$tmp_env"
  mv "$tmp_env" "$1"
}

# Succeeds when version <a> sorts below <b>: numeric major.minor.patch, a prerelease below its release.
version_below() {
  core_a=${1%%-*}
  core_b=${2%%-*}
  for field in 1 2 3; do
    part_a=$(printf '%s' "$core_a" | cut -d. -f"$field")
    part_b=$(printf '%s' "$core_b" | cut -d. -f"$field")
    [ "$part_a" -lt "$part_b" ] && return 0
    [ "$part_a" -gt "$part_b" ] && return 1
  done
  [ "$core_a" != "$1" ] && [ "$core_b" = "$2" ]
}

# Prints to stderr how to put back the registry backed up as *.bak-<version> and run <version>.
rollback_steps() {
  restore="cd /data && rm -f hattisar.db-wal hattisar.db-shm"
  restore="$restore && for f in hattisar.db*.bak-$1; do cp -p \"\$f\" \"\${f%.bak-$1}\"; done"
  {
    echo "To roll back to $1, in $dir:"
    echo "  docker compose stop hattisar"
    echo "  docker compose run --rm --no-deps --entrypoint sh hattisar -c '$restore'"
    echo "then set HATTISAR_VERSION=$1 in .env and run docker compose up -d."
  } >&2
}

# Prints the backup script's report lines (copied|kept <path>) for people.
describe_backup() {
  sed -e 's/^copied \(.*\)/  \1/' -e 's/^kept \(.*\)/  \1 (kept from an earlier attempt)/'
}

main() {
  set -eu

  dir=/opt/hattisar
  version=
  domain=
  domain_set=
  managed_boxes=
  yes=

  while [ $# -gt 0 ]; do
    case $1 in
      --dir)
        if [ $# -lt 2 ] || [ -z "$2" ]; then usage_error "--dir needs a path"; fi
        dir=$2
        shift 2
        ;;
      --version)
        [ $# -ge 2 ] || usage_error "--version needs a version like 1.2.3"
        valid_version "$2" || usage_error "--version must look like 1.2.3, got $2"
        version=$2
        shift 2
        ;;
      --domain)
        [ $# -ge 2 ] || usage_error "--domain needs a domain name"
        valid_domain "$2" || usage_error "--domain must be a domain name like hattisar.example.com, got $2"
        domain=$2
        domain_set=1
        shift 2
        ;;
      --no-domain)
        domain=
        domain_set=1
        shift
        ;;
      --managed-boxes)
        managed_boxes=true
        shift
        ;;
      --no-managed-boxes)
        managed_boxes=false
        shift
        ;;
      --yes)
        yes=1
        shift
        ;;
      *) usage_error "unknown option $1" ;;
    esac
  done

  os=$(uname -s)
  arch=$(uname -m)
  [ "$os" = Linux ] || fail "hattisar installs on Linux only, not $os"
  case $arch in
    x86_64 | aarch64) ;;
    *) fail "hattisar installs on x86_64 or aarch64 only, not $arch" ;;
  esac
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v docker >/dev/null 2>&1 || fail "Docker is required: https://docs.docker.com/engine/install/"
  command -v openssl >/dev/null 2>&1 || fail "openssl is required"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose version failed)"

  if [ -f "$dir/.env" ]; then
    upgrade=1
    old_version=$(sed -n 's|.*image: ghcr\.io/itsbohara/hattisar:.*:-\([^}]*\)}.*|\1|p' \
      "$dir/compose.yml" 2>/dev/null | head -n 1)
    valid_version "$old_version" || fail "cannot read the installed version from $dir/compose.yml"
    if [ -n "$domain_set" ] || [ -n "$managed_boxes" ]; then
      echo "install: an upgrade keeps $dir/.env, so the domain and managed-boxes flags were ignored. To change them, edit HATTISAR_DOMAIN, HATTISAR_PUBLIC_HOST, HATTISAR_COOKIE_SECURE, HATTISAR_MANAGED_BOXES and COMPOSE_PROFILES in .env, then run docker compose up -d in $dir" >&2
    fi
  else
    upgrade=
    # compose.yml fixes `name: hattisar`, so every install dir shares these volumes.
    volumes=$(docker volume ls -q --filter label=com.docker.compose.project=hattisar) ||
      fail "cannot reach the Docker daemon (is it running? rootless Docker is not supported)"
    if [ -n "$volumes" ]; then
      names=$(printf '%s' "$volumes" | tr '\n' ' ')
      fail "Docker volumes of an earlier hattisar install exist: ${names% }. Restore the .env of that install into $dir to keep its data, or run docker compose down -v in it to reset deliberately"
    fi
    if [ -z "$domain_set" ] && [ -z "$yes" ]; then
      has_tty || usage_error "no terminal to ask for a domain; pass --domain <name> or --no-domain"
      ask_domain
    fi
    if [ -z "$managed_boxes" ]; then
      if [ -n "$yes" ]; then
        managed_boxes=true
      else
        has_tty ||
          usage_error "no terminal to ask about managed boxes; pass --managed-boxes or --no-managed-boxes"
        ask_managed_boxes
      fi
    fi
  fi

  base=${HATTISAR_RELEASES_URL:-https://github.com/itsbohara/hattisar/releases}
  if [ -z "$version" ]; then
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$base/latest") ||
      fail "could not find the latest release at $base/latest"
    version=${latest##*/}
    version=${version#v}
    valid_version "$version" || fail "could not find the latest release at $base/latest"
  fi

  if [ -n "$upgrade" ]; then
    if version_below "$version" "$old_version"; then
      echo "install: refusing to downgrade from $old_version to $version: the registry may hold $old_version's migrations, which $version cannot read. Going back means restoring the registry backup taken before $old_version (hattisar.db.bak-$version, if that upgrade made one)." >&2
      rollback_steps "$version"
      exit 1
    fi
    pinned=$(env_value HATTISAR_VERSION "$dir/.env")
    if [ -n "$pinned" ]; then
      echo "install: $dir/.env sets HATTISAR_VERSION=$pinned, which overrides the $version that compose.yml pins; remove that line to run $version" >&2
    fi
  fi

  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  trap 'exit 1' HUP INT TERM

  url="$base/download/v$version/hattisar-$version.tar.gz"
  echo "Downloading hattisar $version"
  curl -fsSL -o "$stage/bundle.tar.gz" "$url" || fail "could not download $url"
  tar -xzf "$stage/bundle.tar.gz" -C "$stage" || fail "could not unpack $url"
  bundle=$stage/hattisar
  [ -f "$bundle/compose.yml" ] || fail "$url is not a hattisar bundle"
  if [ -n "$upgrade" ]; then
    serves_domain=$(env_value HATTISAR_DOMAIN "$dir/.env")
  else
    serves_domain=$domain
  fi
  if ! grep -q HATTISAR_BIND "$bundle/compose.yml" ||
    { [ -n "$serves_domain" ] && [ ! -f "$bundle/volumes/caddy/Caddyfile" ]; }; then
    fail "hattisar $version predates the installer; pass --version <newer>"
  fi

  # The install directory stays untouched until the new images are pulled and, on an upgrade, the
  # registry is backed up: a failure before then leaves the old install (and its version) intact.
  if [ -n "$upgrade" ]; then
    cp "$dir/.env" "$bundle/.env" || fail "cannot read $dir/.env; run with sudo"
    sh "$bundle/generate-env.sh" "$bundle/env.example" "$bundle/.env" >/dev/null ||
      fail "could not complete .env for the new version"
  else
    sh "$bundle/generate-env.sh" "$bundle/env.example" "$bundle/.env" >/dev/null ||
      fail "could not generate .env"
    set_env "$bundle/.env" HATTISAR_BIND 127.0.0.1
    profiles=
    if [ -n "$domain" ]; then
      set_env "$bundle/.env" HATTISAR_DOMAIN "$domain"
      set_env "$bundle/.env" HATTISAR_PUBLIC_HOST "$domain"
      set_env "$bundle/.env" HATTISAR_COOKIE_SECURE true
      profiles=caddy
    fi
    set_env "$bundle/.env" HATTISAR_MANAGED_BOXES "$managed_boxes"
    if [ "$managed_boxes" = true ]; then
      profiles=${profiles:+$profiles,}managed-boxes
    fi
    set_env "$bundle/.env" COMPOSE_PROFILES "$profiles"
  fi

  (cd "$bundle" && docker compose pull) || fail "docker compose pull failed; nothing was changed"

  backup=
  if [ -n "$upgrade" ]; then
    (cd "$dir" && docker compose stop hattisar) ||
      fail "docker compose stop hattisar failed; $old_version is still installed in $dir"
    # old_version passed valid_version above, so it is safe inside this shell command.
    # A backup set left by an earlier attempt is the clean pre-upgrade copy: keep all of it, since a
    # fresh -wal next to an old .db backup would not belong to it.
    files="hattisar.db hattisar.db-wal hattisar.db-shm"
    copy="set -e; cd /data; [ -f hattisar.db ] || exit 0"
    copy="$copy; if [ -e hattisar.db.bak-$old_version ]; then for f in $files; do"
    copy="$copy if [ -e \$f.bak-$old_version ]; then echo kept /data/\$f.bak-$old_version; fi; done; exit 0; fi"
    copy="$copy; for f in $files; do if [ -f \$f ]; then"
    copy="$copy cp -p \$f \$f.bak-$old_version; echo copied /data/\$f.bak-$old_version; fi; done"
    backup=$(cd "$dir" && docker compose run -T --rm --no-deps --entrypoint sh hattisar -c "$copy" </dev/null) ||
      fail "could not back up the registry; $old_version is still installed in $dir, stopped (docker compose up -d there restarts it)"
    rm "$bundle/.env"
  fi

  mkdir -p "$dir" 2>/dev/null || fail "cannot create $dir; run with sudo or pass --dir"
  cp -R "$bundle/." "$dir/" || fail "cannot write to $dir; run with sudo or pass --dir"
  if [ -n "$upgrade" ]; then
    sh "$dir/generate-env.sh" "$dir/env.example" "$dir/.env" || fail "could not add new keys to $dir/.env"
  fi

  cd "$dir" || fail "cannot enter $dir"
  if ! docker compose up -d --wait; then
    echo "install: docker compose up failed; see docker compose logs in $dir" >&2
    if [ -n "$upgrade" ]; then
      if [ -n "$backup" ]; then
        echo "The $old_version registry is backed up in the hattisar-data volume:" >&2
        printf '%s\n' "$backup" | describe_backup >&2
      fi
      rollback_steps "$old_version"
    else
      echo "The admin username and password are in $dir/.env. Re-running the installer now upgrades this install and asks nothing again: change the answers in $dir/.env, or start over by running docker compose down -v in $dir and removing $dir." >&2
    fi
    exit 1
  fi

  domain=$(env_value HATTISAR_DOMAIN .env)
  if [ -n "$domain" ]; then
    url="https://$domain"
  else
    port=$(env_value HATTISAR_PORT .env)
    url="http://localhost:${port:-8000}"
  fi

  echo
  if [ -n "$upgrade" ]; then
    echo "hattisar upgraded from $old_version to $version."
    echo "  URL:      $url"
    if [ -n "$backup" ]; then
      echo "The $old_version registry is backed up in the hattisar-data volume:"
      printf '%s\n' "$backup" | describe_backup
    fi
  else
    echo "hattisar $version is running."
    echo "  URL:      $url"
    echo "  Username: $(env_value HATTISAR_ADMIN_USERNAME .env)"
    echo "  Password: $(env_value HATTISAR_ADMIN_PASSWORD .env)"
    if [ -n "$domain" ]; then
      echo "Point $domain at this server; Caddy gets its certificate on the first request."
    else
      echo "hattisar listens on 127.0.0.1 only; reach it through an SSH tunnel or your own proxy."
    fi
  fi
}

main "$@"
