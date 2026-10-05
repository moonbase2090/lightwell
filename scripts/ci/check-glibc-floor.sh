#!/usr/bin/env bash
set -euo pipefail

binary="${1:?Usage: check-glibc-floor.sh <binary> [maximum-glibc-version]}"
maximum_allowed="${2:-2.28}"
if [[ ! -x "$binary" ]]; then
  echo "Binary does not exist or is not executable: $binary" >&2
  exit 1
fi

versions=$(LANG=C readelf -W --version-info --dyn-syms "$binary" \
  | sed -nE 's/.*Name: GLIBC_([0-9.]+)[[:space:]]+Flags.*/\1/p' \
  | sort -Vu)
if [[ -z "$versions" ]]; then
  echo "No versioned GLIBC symbols found in $binary" >&2
  exit 1
fi

maximum_required=$(printf '%s\n' "$versions" | tail -n 1)
latest=$(printf '%s\n%s\n' "$maximum_required" "$maximum_allowed" | sort -V | tail -n 1)
if [[ "$latest" != "$maximum_allowed" ]]; then
  echo "$binary requires GLIBC_$maximum_required; the maximum allowed is GLIBC_$maximum_allowed" >&2
  exit 1
fi

printf 'GLIBC maximum: %s (allowed: %s)\n' "$maximum_required" "$maximum_allowed"
