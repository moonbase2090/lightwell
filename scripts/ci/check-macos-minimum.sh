#!/usr/bin/env bash
set -euo pipefail

target="${1:?Usage: check-macos-minimum.sh <binary-or-app-bundle> [expected-minimum]}"
expected="${2:-11.0}"

if [[ -d "$target" ]]; then
  plist="$target/Contents/Info.plist"
  if [[ ! -f "$plist" ]]; then
    printf 'App bundle has no Info.plist: %s\n' "$target" >&2
    exit 1
  fi
  minimum=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")
elif [[ -f "$target" ]]; then
  minimum=$(otool -l "$target" | awk '$1 == "minos" { print $2; exit }')
else
  printf 'Binary or app bundle does not exist: %s\n' "$target" >&2
  exit 1
fi

printf '%s minimum macOS version: %s\n' "$target" "$minimum"
if [[ "$minimum" != "$expected" ]]; then
  printf 'expected a macOS %s minimum, found %s\n' "$expected" "${minimum:-none}" >&2
  exit 1
fi
