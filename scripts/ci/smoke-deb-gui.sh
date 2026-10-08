#!/usr/bin/env bash
set -euo pipefail

package="${1:?Usage: smoke-deb-gui.sh <deb-or-directory-with-one-deb> <screenshot-path>}"
screenshot_path="${2:?Usage: smoke-deb-gui.sh <deb-or-directory-with-one-deb> <screenshot-path>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -d "$package" ]]; then
  package="$(find "$package" -maxdepth 1 -type f -name '*.deb' -print -quit)"
fi
if [[ -z "$package" || ! -f "$package" ]]; then
  printf 'No .deb package found.\n' >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dpkg-deb -x "$package" "$work"
binary="$(find "$work/usr" -type f -executable -name lightwell -print -quit)"
if [[ -z "$binary" ]]; then
  printf 'The package has no lightwell binary.\n' >&2
  exit 1
fi

printf 'Opening the packaged desktop app: %s\n' "$binary"
"$script_dir/capture-open-workspace.sh" "$binary" "$screenshot_path"
