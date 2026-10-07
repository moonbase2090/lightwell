#!/usr/bin/env bash
set -euo pipefail
umask 077

app="${1:?Usage: notarize-macos-app.sh LIGHTWELL_APP OUTPUT_ZIP}"
output_zip="${2:?Usage: notarize-macos-app.sh LIGHTWELL_APP OUTPUT_ZIP}"

for name in APPLE_NOTARY_ISSUER APPLE_NOTARY_KEY_ID APPLE_NOTARY_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required for macOS notarization" >&2
    exit 1
  fi
done
[[ -d "$app" ]] || { echo "Lightwell.app is missing: $app" >&2; exit 1; }

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lightwell-notary.XXXXXX")"
notary_key="$work/AuthKey.p8"
submit_zip="$work/Lightwell-submit.zip"
cleanup() {
  local status=$?
  trap - EXIT
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

ditto -c -k --keepParent "$app" "$submit_zip"
submission_json="$work/notary-submit.json"
submission_error="$work/notary-submit.err"
if ! xcrun notarytool submit "$submit_zip" --wait \
  --issuer "$APPLE_NOTARY_ISSUER" \
  --key-id "$APPLE_NOTARY_KEY_ID" \
  --key "$notary_key" \
  --output-format json >"$submission_json" 2>"$submission_error"; then
  echo 'notarytool submit failed; Apple credentials or notarization service rejected the archive' >&2
  exit 1
fi
status="$(python3 - "$submission_json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as stream:
        print(json.load(stream).get("status", ""))
except (OSError, ValueError):
    print("")
PY
)"
if [[ "$status" != Accepted ]]; then
  echo "notarization was not accepted (status: ${status:-unknown})" >&2
  exit 1
fi
echo 'Apple notarization accepted.'

xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
ditto -c -k --keepParent "$app" "$output_zip"
# The final archive is created only after stapling and Gatekeeper validation.
test -s "$output_zip"
echo "Stapled and validated macOS artifact: $output_zip"
