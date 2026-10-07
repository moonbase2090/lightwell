#!/usr/bin/env bash
set -euo pipefail

bin_dir="${1:?Usage: smoke-deb-al2023.sh UNPACKED_BIN_DIR PROJECT_ROOT}"
project_root="${2:?Usage: smoke-deb-al2023.sh UNPACKED_BIN_DIR PROJECT_ROOT}"
bin_dir="$(cd "$bin_dir" && pwd)"
project_root="$(cd "$project_root" && pwd)"
binary="$bin_dir/lightwell"

if [[ ! -x "$binary" ]]; then
  printf 'Unpacked Debian binary is missing or not executable: %s\n' "$binary" >&2
  exit 1
fi

printf 'Running packaged Lightwell binary in amazonlinux:2023: %s\n' "$binary"
docker run --rm --interactive \
  --volume "$bin_dir:/release:ro" \
  --volume "$project_root:/workspace:ro" \
  amazonlinux:2023 \
  bash -s <<'AL2023'
set -euo pipefail
dnf --assumeyes install binutils python3
/release/lightwell --help
/release/lightwell extract /workspace -o /tmp/lightwell-map.json --name Lightwell
python3 - /tmp/lightwell-map.json <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as facts_file:
    facts = json.load(facts_file)

if facts.get("schemaVersion") != 1:
    raise SystemExit("lightwell wrote a facts file with an unexpected schema version")
if not facts.get("blocks"):
    raise SystemExit("lightwell wrote a facts file with no blocks")
print(f"Amazon Linux 2023 smoke passed: schema v1 with {len(facts['blocks'])} blocks.")
PY
AL2023
