#!/usr/bin/env bash
# Fail when a release binary would load the Vite dev server instead of the
# bundled viewer (issue #99). A release build embeds dist/ and must not carry
# the devUrl from tauri.conf.json.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf 'Usage: check-no-localhost.sh BINARY...\n' >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dev_url="$(node -p "require('$repo_root/crates/lightwell-app/tauri.conf.json').build.devUrl")"
port="${dev_url##*:}"
port="${port%%/*}"

status=0
for binary in "$@"; do
  if [[ ! -f "$binary" ]]; then
    printf 'missing binary: %s\n' "$binary" >&2
    status=1
    continue
  fi
  if LC_ALL=C grep -a -q -E "(localhost|127\.0\.0\.1):$port" "$binary"; then
    printf '%s points at the dev server %s\n' "$binary" "$dev_url" >&2
    status=1
  else
    printf '%s does not point at the dev server\n' "$binary"
  fi
done
exit "$status"
