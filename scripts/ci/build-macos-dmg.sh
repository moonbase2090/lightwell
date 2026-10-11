#!/usr/bin/env bash
# Build the drag-to-Applications Lightwell disk image (layout ported from Prismattyc).
set -euo pipefail

app="${1:?Usage: build-macos-dmg.sh LIGHTWELL_APP OUTPUT_DMG}"
dmg="${2:?Usage: build-macos-dmg.sh LIGHTWELL_APP OUTPUT_DMG}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

[[ -d "$app" ]] || { echo "Lightwell.app is missing: $app" >&2; exit 1; }
if [[ -e "$dmg" ]]; then
  echo "refusing to overwrite existing disk image: $dmg" >&2
  exit 1
fi
command -v dmgbuild >/dev/null || { echo 'dmgbuild is required (pip install dmgbuild==1.6.7)' >&2; exit 1; }

dmgbuild -s "$root/scripts/release/dmgbuild_settings.py" \
  -D "app=$app" -D "root=$root" Lightwell "$dmg"
echo "Built $(basename "$dmg")"
