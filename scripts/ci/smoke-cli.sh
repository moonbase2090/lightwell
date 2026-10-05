#!/usr/bin/env bash
set -euo pipefail

cli="${1:?Usage: smoke-cli.sh CLI_BINARY PROJECT_ROOT OUTPUT_JSON}"
project_root="${2:?Usage: smoke-cli.sh CLI_BINARY PROJECT_ROOT OUTPUT_JSON}"
output_json="${3:?Usage: smoke-cli.sh CLI_BINARY PROJECT_ROOT OUTPUT_JSON}"

if [[ ! -x "$cli" ]]; then
  printf 'CLI binary is missing or not executable: %s\n' "$cli" >&2
  exit 1
fi

"$cli" --help
"$cli" extract "$project_root" -o "$output_json" --name Lightwell
python3 - "$output_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as facts_file:
    facts = json.load(facts_file)

if facts.get("schemaVersion") != 1:
    raise SystemExit("lightwell wrote a facts file with an unexpected schema version")
if not facts.get("blocks"):
    raise SystemExit("lightwell wrote a facts file with no blocks")
if facts.get("stats", {}).get("blocks") != len(facts["blocks"]):
    raise SystemExit("lightwell block statistics do not match its facts")

print(f"CLI smoke passed: schema v1 with {len(facts['blocks'])} blocks.")
PY
