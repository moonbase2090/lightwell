#!/usr/bin/env bash
# Write public release notes from an annotated tag, without SSH/PGP signature blocks.
set -euo pipefail

usage() {
  echo "usage: release-notes-from-tag.sh TAG [OUTFILE]" >&2
}

tag="${1:-}"
output="${2:-}"

if [[ -z "$tag" ]]; then
  usage
  exit 2
fi

if ! git rev-parse "refs/tags/${tag}" >/dev/null 2>&1; then
  echo "release-notes-from-tag: missing tag ${tag}" >&2
  exit 1
fi

message="$(git for-each-ref "refs/tags/${tag}" --format='%(contents)')"

strip_tag_signatures() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      '-----BEGIN SSH SIGNATURE-----' | '-----BEGIN PGP SIGNATURE-----')
        break
        ;;
    esac
    printf '%s\n' "$line"
  done <<<"$message"
}

notes="$(strip_tag_signatures)"
while [[ -n "$notes" && "$notes" == *$'\n' ]]; do
  notes="${notes%$'\n'}"
done

if [[ -z "${notes//[[:space:]]/}" ]]; then
  notes="Lightwell ${tag#v}"
fi

if [[ -n "$output" ]]; then
  printf '%s\n' "$notes" >"$output"
else
  printf '%s\n' "$notes"
fi
