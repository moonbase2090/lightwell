#!/usr/bin/env bash
set -euo pipefail

app="${1:?Usage: check-unsigned-macos-app.sh <app-bundle>}"
if [[ ! -d "$app" ]]; then
  printf 'App bundle does not exist: %s\n' "$app" >&2
  exit 1
fi

if codesign --verify --deep --strict "$app" 2>/dev/null; then
  printf 'Expected an unsigned macOS app, but codesign verified the bundle: %s\n' "$app" >&2
  exit 1
fi
printf '%s is unsigned, as expected\n' "$app"
