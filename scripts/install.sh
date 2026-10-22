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

# Sets <key>=<value> in <dir>/.env, replacing the key's line in place or appending one.
set_env() {
  tmp_env=$(mktemp "$dir/.env.XXXXXX")
  KEY=$1 VALUE=$2 awk '
    BEGIN { key = ENVIRON["KEY"]; line = key "=" ENVIRON["VALUE"] }
    index($0, key "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$dir/.env" >"$tmp_env"
  mv "$tmp_env" "$dir/.env"
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
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose version failed)"

  if [ -f "$dir/.env" ]; then
    upgrade=1
    old_version=$(sed -n 's|.*image: ghcr\.io/itsbohara/hattisar:.*:-\([^}]*\)}.*|\1|p' \
      "$dir/compose.yml" 2>/dev/null | head -n 1)
    valid_version "$old_version" || fail "cannot read the installed version from $dir/compose.yml"
  else
    upgrade=
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

  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  trap 'exit 1' HUP INT TERM

  url="$base/download/v$version/hattisar-$version.tar.gz"
  echo "Downloading hattisar $version"
  curl -fsSL -o "$stage/bundle.tar.gz" "$url" || fail "could not download $url"
  tar -xzf "$stage/bundle.tar.gz" -C "$stage" || fail "could not unpack $url"
  [ -f "$stage/hattisar/compose.yml" ] || fail "$url is not a hattisar bundle"

  mkdir -p "$dir" 2>/dev/null || fail "cannot create $dir; run with sudo or pass --dir"
  cp -R "$stage/hattisar/." "$dir/" || fail "cannot write to $dir; run with sudo or pass --dir"
  sh "$dir/generate-env.sh" "$dir/env.example" "$dir/.env"

  if [ -z "$upgrade" ]; then
    set_env HATTISAR_BIND 127.0.0.1
    profiles=
    if [ -n "$domain" ]; then
      set_env HATTISAR_DOMAIN "$domain"
      set_env HATTISAR_PUBLIC_HOST "$domain"
      set_env HATTISAR_COOKIE_SECURE true
      profiles=caddy
    fi
    set_env HATTISAR_MANAGED_BOXES "$managed_boxes"
    if [ "$managed_boxes" = true ]; then
      profiles=${profiles:+$profiles,}managed-boxes
    fi
    set_env COMPOSE_PROFILES "$profiles"
  fi

  cd "$dir"
  docker compose pull || fail "docker compose pull failed"
  if [ -n "$upgrade" ]; then
    docker compose stop hattisar || fail "docker compose stop hattisar failed"
    # old_version passed valid_version above, so it is safe inside this shell command.
    docker compose run --rm --no-deps --entrypoint sh hattisar -c \
      "if [ -f /data/hattisar.db ]; then cp -p /data/hattisar.db /data/hattisar.db.bak-$old_version; fi" ||
      fail "could not back up the registry to /data/hattisar.db.bak-$old_version"
  fi
  docker compose up -d --wait || fail "docker compose up failed; see docker compose logs in $dir"

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
    echo "The previous registry, if there was one, is /data/hattisar.db.bak-$old_version in the hattisar-data volume."
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
