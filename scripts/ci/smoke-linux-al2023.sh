#!/usr/bin/env bash
set -euo pipefail

bin_dir="${1:?Usage: smoke-linux-al2023.sh BIN_DIR PROJECT_ROOT}"
project_root="${2:?Usage: smoke-linux-al2023.sh BIN_DIR PROJECT_ROOT}"
bin_dir="$(cd "$bin_dir" && pwd)"
project_root="$(cd "$project_root" && pwd)"
binary="$bin_dir/lightwell"

if [[ ! -x "$binary" ]]; then
  printf 'CLI binary is missing or not executable: %s\n' "$binary" >&2
  exit 1
fi

max_version="$(objdump -T "$binary" \
  | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' \
  | sed 's/^GLIBC_//' \
  | sort -V \
  | tail -n 1 || true)"
if [[ -z "$max_version" ]]; then
  printf 'could not read GLIBC symbol versions from %s\n' "$binary" >&2
  exit 1
fi
printf 'lightwell max GLIBC_%s\n' "$max_version"
if [[ "$(printf '%s\n' "$max_version" 2.28 | sort -V | tail -n 1)" != 2.28 ]]; then
  printf 'lightwell requires GLIBC_%s, above the 2.28 floor\n' "$max_version" >&2
  exit 1
fi

smoke=$(cat <<'AL2023'
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
)

if docker info >/dev/null 2>&1; then
  docker run --rm --interactive \
    --volume "$bin_dir:/release:ro" \
    --volume "$project_root:/workspace:ro" \
    amazonlinux:2023 \
    bash -s <<<"$smoke"
  exit 0
fi

root=/opt/amazonlinux-2023
if [[ ! -x "$root/bin/bash" ]]; then
  printf 'Amazon Linux smoke needs Docker or %s\n' "$root" >&2
  exit 1
fi
sudo cp /etc/resolv.conf "$root/etc/resolv.conf"
sudo mkdir -p "$root/release" "$root/workspace"
sudo cp -a "$bin_dir/." "$root/release/"
sudo cp -a "$project_root/." "$root/workspace/"
sudo chroot "$root" /bin/bash -s <<<"$smoke"
