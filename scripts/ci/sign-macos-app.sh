#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo "Usage: sign-macos-app.sh --credential-smoke | APP_PATH" >&2
  exit 2
}

mode=""
app=""
case "${1:-}" in
  --credential-smoke) mode=credential-smoke ;;
  "") usage ;;
  *) [[ $# -eq 1 ]] || usage; mode=sign; app="$1" ;;
esac

required_secret() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required for the Apple signing credential smoke" >&2
    exit 1
  fi
}

for name in APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD; do
  required_secret "$name"
done
if [[ "$mode" == credential-smoke ]]; then
  for name in APPLE_NOTARY_ISSUER APPLE_NOTARY_KEY_ID APPLE_NOTARY_KEY; do
    required_secret "$name"
  done
fi

if [[ "$mode" == sign && ! -d "$app" ]]; then
  echo "Lightwell.app is missing: $app" >&2
  exit 1
fi

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lightwell-sign.XXXXXX")"
keychain="$work/lightwell-signing.keychain-db"
certificate="$work/developer-id.p12"
notary_key="$work/AuthKey.p8"
keychain_password="$(openssl rand -hex 32)"

cleanup() {
  local status=$?
  trap - EXIT
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

base64_decode() {
  if /usr/bin/base64 -D </dev/null >/dev/null 2>&1; then
    /usr/bin/base64 -D
  else
    /usr/bin/base64 --decode
  fi
}

if ! printf '%s' "$APPLE_CERTIFICATE_P12" | base64_decode >"$certificate"; then
  echo "APPLE_CERTIFICATE_P12 is not valid base64" >&2
  exit 1
fi
chmod 600 "$certificate"

security create-keychain -p "$keychain_password" "$keychain" >/dev/null
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
if ! security import "$certificate" -f pkcs12 -k "$keychain" \
  -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1; then
  echo "APPLE_CERTIFICATE_PASSWORD or APPLE_CERTIFICATE_P12 could not import the certificate" >&2
  exit 1
fi
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$keychain_password" "$keychain" >/dev/null

identity_lines="$(security find-identity -v -p codesigning "$keychain" \
  | sed -n '/"Developer ID Application:/p')"
identity_count="$(printf '%s\n' "$identity_lines" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
if [[ "$identity_count" != 1 ]]; then
  echo "expected exactly one Developer ID Application identity in APPLE_CERTIFICATE_P12" >&2
  exit 1
fi
expected_identity='Developer ID Application: Moonbase 2090 LLC (S24C53PD3Y)'
if ! printf '%s\n' "$identity_lines" | grep -Fq "\"$expected_identity\""; then
  echo "APPLE_CERTIFICATE_P12 does not contain the expected $expected_identity identity" >&2
  exit 1
fi
identity="$(printf '%s\n' "$identity_lines" | awk '{print $2}')"
echo "Apple signing identity confirmed: $expected_identity"

if [[ "$mode" == credential-smoke ]]; then
  case "$APPLE_NOTARY_KEY" in
    *'-----BEGIN '*) printf '%s\n' "$APPLE_NOTARY_KEY" >"$notary_key" ;;
    *)
      if ! printf '%s' "$APPLE_NOTARY_KEY" | base64_decode >"$notary_key"; then
        echo "APPLE_NOTARY_KEY is neither PEM nor valid base64" >&2
        exit 1
      fi
      ;;
  esac
  chmod 600 "$notary_key"
  if ! grep -Eq -- '-----BEGIN (EC |RSA )?PRIVATE KEY-----' "$notary_key"; then
    echo "APPLE_NOTARY_KEY does not contain a PEM private key" >&2
    exit 1
  fi
  history_json="$work/notary-history.json"
  if ! xcrun notarytool history \
    --issuer "$APPLE_NOTARY_ISSUER" \
    --key-id "$APPLE_NOTARY_KEY_ID" \
    --key "$notary_key" \
    --output-format json >"$history_json" 2>"$work/notary-history.err"; then
    echo "notarytool history failed; check APPLE_NOTARY_ISSUER, APPLE_NOTARY_KEY_ID, or APPLE_NOTARY_KEY" >&2
    exit 1
  fi
  if ! python3 - "$history_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    json.load(stream)
PY
  then
    echo "notarytool history returned invalid JSON; check APPLE_NOTARY_ISSUER, APPLE_NOTARY_KEY_ID, or APPLE_NOTARY_KEY" >&2
    exit 1
  fi
  echo 'Apple credential smoke passed: certificate identity and notary history are valid.'
  exit 0
fi

minimum="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist")"
if [[ "$minimum" != 11.0 ]]; then
  echo "expected macOS minimum 11.0, found $minimum" >&2
  exit 1
fi

sign_code() {
  codesign --force --options runtime --timestamp --keychain "$keychain" \
    --sign "$identity" "$1" >/dev/null
}
is_macho() {
  file -b "$1" | grep -q 'Mach-O'
}

while IFS= read -r -d '' binary; do
  if is_macho "$binary"; then
    sign_code "$binary"
  fi
done < <(find "$app/Contents" -type f -print0)
bundle_list="$work/bundles.nul"
python3 - "$app/Contents" "$bundle_list" <<'PY'
import os
import sys
from pathlib import Path

root, output = map(Path, sys.argv[1:])
suffixes = {".app", ".appex", ".framework", ".bundle", ".plugin", ".xpc"}
bundles = [
    path for path in root.rglob("*")
    if path.is_dir() and not path.is_symlink() and path.suffix in suffixes
]
bundles.sort(key=lambda path: (len(path.parts), str(path)), reverse=True)
with output.open("wb") as stream:
    for bundle in bundles:
        stream.write(os.fsencode(bundle) + b"\\0")
PY
while IFS= read -r -d '' bundle; do
  sign_code "$bundle"
done < "$bundle_list"
sign_code "$app"

codesign --verify --deep --strict --verbose=2 "$app"
echo 'Signed Lightwell.app verification passed.'
