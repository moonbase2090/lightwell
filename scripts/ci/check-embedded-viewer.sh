#!/usr/bin/env bash
# Fail when a release binary would load the Vite dev server (localhost)
# instead of the bundled viewer (issue #99). A release build with the
# custom-protocol feature embeds dist/ and keys each asset by its path, so
# every hashed file under dist/assets must be named in the binary. A dev
# build embeds no assets. (The devUrl string itself stays in the embedded
# config either way, so searching for localhost proves nothing.)
set -euo pipefail

usage='Usage: check-embedded-viewer.sh DIST_DIR BINARY...'
dist="${1:?$usage}"
shift
[[ $# -gt 0 ]] || { printf '%s\n' "$usage" >&2; exit 2; }

assets=()
while IFS= read -r file; do
  assets+=("/assets/$(basename "$file")")
done < <(find "$dist/assets" -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) | sort)
if [[ ${#assets[@]} -eq 0 ]]; then
  printf 'no built viewer assets under %s/assets\n' "$dist" >&2
  exit 1
fi

status=0
for binary in "$@"; do
  missing=0
  for asset in "${assets[@]}"; do
    if ! LC_ALL=C grep -a -q -F "$asset" "$binary"; then
      printf '%s does not embed %s; it would load the dev server\n' "$binary" "$asset" >&2
      missing=1
    fi
  done
  if [[ $missing -eq 0 ]]; then
    printf '%s embeds the viewer (%d assets)\n' "$binary" "${#assets[@]}"
  else
    status=1
  fi
done
exit "$status"
