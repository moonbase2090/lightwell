#!/usr/bin/env bash
set -euo pipefail

package="${1:?Usage: check-deb-glibc.sh <deb-or-directory-with-one-deb> [maximum-glibc-version]}"
maximum_allowed="${2:-2.28}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -d "$package" ]]; then
  directory="$package"
  package=$(find "$directory" -maxdepth 1 -type f -name '*.deb' -print -quit)
  if [[ -z "$package" ]]; then
    printf 'No .deb package found in %s\n' "$directory" >&2
    exit 1
  fi
elif [[ ! -f "$package" ]]; then
  printf 'Package does not exist: %s\n' "$package" >&2
  exit 1
fi

unpacked="$(mktemp -d "${TMPDIR:-/tmp}/lightwell-deb.XXXXXX")"
trap 'rm -rf "$unpacked"' EXIT
dpkg-deb -x "$package" "$unpacked"
binary=$(find "$unpacked/usr" -type f -executable -name lightwell -print -quit 2>/dev/null || true)
if [[ -z "$binary" ]]; then
  printf 'No lightwell executable under usr/ in %s\n' "$package" >&2
  exit 1
fi

"$script_dir/check-glibc-floor.sh" "$binary" "$maximum_allowed"
