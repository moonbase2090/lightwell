#!/bin/sh
# Sign updater artifacts in DIST and write latest.json when the signing key is set.
# Usage: publish-update-manifest.sh DIST NOTES VERSION TAG
set -eu

dist=$1
notes=$2
version=$3
tag=$4

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  printf 'TAURI_SIGNING_PRIVATE_KEY is not set. This release will not include latest.json.\n'
  exit 0
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

sign() {
  file=$1
  if [ ! -f "$file" ]; then
    return 0
  fi
  npx --yes @tauri-apps/cli@2.12.1 signer sign \
    --app-version "$version" \
    "$file"
}

sign "$dist/Lightwell_${version}_aarch64.app.tar.gz"
sign "$dist/Lightwell_${version}_universal.app.tar.gz"
sign "$dist/Lightwell_${version}_amd64.AppImage"
sign "$dist/Lightwell_${version}_x64.msi"

python3 scripts/ci/assemble-update-manifest.py \
  --version "$version" \
  --tag "$tag" \
  --notes "$notes" \
  --out "$dist/latest.json" \
  --asset darwin-aarch64 "Lightwell_${version}_aarch64.app.tar.gz" "$dist/Lightwell_${version}_aarch64.app.tar.gz.sig" \
  --asset darwin-x86_64 "Lightwell_${version}_universal.app.tar.gz" "$dist/Lightwell_${version}_universal.app.tar.gz.sig" \
  --asset linux-x86_64 "Lightwell_${version}_amd64.AppImage" "$dist/Lightwell_${version}_amd64.AppImage.sig" \
  --asset windows-x86_64 "Lightwell_${version}_x64.msi" "$dist/Lightwell_${version}_x64.msi.sig"
