#!/usr/bin/env bash
set -euo pipefail

host="${1:?Usage: browser-preview-proof.sh HOST PORT PROOF_DIR}"
port="${2:?Usage: browser-preview-proof.sh HOST PORT PROOF_DIR}"
proof_dir="${3:?Usage: browser-preview-proof.sh HOST PORT PROOF_DIR}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
url="http://${host}:${port}/"
mkdir -p "$proof_dir"

if [[ ! -f "$root/dist/index.html" ]]; then
  echo "browser-preview-proof: run npm run build first" >&2
  exit 1
fi

headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$headers" "$body"' EXIT

if ! curl -fsS -D "$headers" -o "$body" "$url"; then
  echo "browser-preview-proof: preview not reachable at $url" >&2
  exit 1
fi

if ! grep -qi '<title>Lightwell</title>' "$root/dist/index.html"; then
  echo "browser-preview-proof: dist/index.html missing Lightwell title" >&2
  exit 1
fi

cp "$headers" "$proof_dir/preview-headers.txt"
cp "$body" "$proof_dir/preview-body.html"
printf '%s\n' "$url" >"$proof_dir/preview-url.txt"
echo "browser-preview-proof: ok"
