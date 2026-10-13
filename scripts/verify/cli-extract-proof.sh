#!/usr/bin/env bash
set -euo pipefail

output_json="${1:?Usage: cli-extract-proof.sh OUTPUT_JSON}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="$root/target/debug/lightwell"

mkdir -p "$(dirname "$output_json")"
if [[ ! -x "$cli" ]]; then
  echo "cli-extract-proof: build the CLI first (scripts/verify/doctor.sh)" >&2
  exit 1
fi

"$root/scripts/ci/smoke-cli.sh" "$cli" "$root" "$output_json"
