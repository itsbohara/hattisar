#!/bin/sh
# Writes docker/.env from docker/env.example with generated secrets. Never overwrites a value:
# keys added to env.example after docker/.env was written are appended with fresh secrets.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)

(cd "$root" && sh scripts/generate-env.sh docker/env.example docker/.env)
