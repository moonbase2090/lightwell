#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

printf 'First line\nQuote "here"\n' > "$work/notes.md"
printf 'sig-aarch64\n' > "$work/aarch64.sig"
printf 'sig-appimage\n' > "$work/appimage.sig"

python3 "$root/scripts/ci/assemble-update-manifest.py" \
  --version 0.1.12 \
  --tag v0.1.12 \
  --notes "$work/notes.md" \
  --out "$work/latest.json" \
  --asset darwin-aarch64 Lightwell_0.1.12_aarch64.app.tar.gz "$work/aarch64.sig" \
  --asset darwin-x86_64 Lightwell_0.1.12_universal.app.tar.gz "$work/missing.sig" \
  --asset linux-x86_64 Lightwell_0.1.12_amd64.AppImage "$work/appimage.sig"

mkdir -p "$work/Lightwell.app"
printf 'app\n' > "$work/Lightwell.app/marker"
sh "$root/scripts/ci/pack-macos-update.sh" "$work/Lightwell.app" "$work/out.tar.gz"
tar -tzf "$work/out.tar.gz" | grep -q 'Lightwell.app/marker'

skip_dist=$(mktemp -d)
skip_out=$(TAURI_SIGNING_PRIVATE_KEY= sh "$root/scripts/ci/publish-update-manifest.sh" "$skip_dist" "$work/notes.md" 0.1.12 v0.1.12)
printf '%s\n' "$skip_out" | grep -q 'will not include latest.json'
test ! -e "$skip_dist/latest.json"

fail_dist=$(mktemp -d)
if LIGHTWELL_RELEASE_REQUIRE_UPDATER_SIGNING=1 TAURI_SIGNING_PRIVATE_KEY= sh "$root/scripts/ci/publish-update-manifest.sh" "$fail_dist" "$work/notes.md" 0.1.12 v0.1.12; then
  printf 'FAIL publish-update-manifest: expected release failure without signing key\n' >&2
  exit 1
fi
test ! -e "$fail_dist/latest.json"

python3 - "$work/latest.json" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
assert manifest["version"] == "0.1.12"
assert manifest["notes"] == 'First line\nQuote "here"'
assert "darwin-x86_64" not in manifest["platforms"]
arm = manifest["platforms"]["darwin-aarch64"]
assert arm["signature"] == "sig-aarch64"
assert arm["url"] == "https://github.com/moonbase2090/lightwell/releases/download/v0.1.12/Lightwell_0.1.12_aarch64.app.tar.gz"
appimage = manifest["platforms"]["linux-x86_64"]
assert appimage["signature"] == "sig-appimage"
assert appimage["url"].endswith("/Lightwell_0.1.12_amd64.AppImage")
print("update manifest ok")
PY
