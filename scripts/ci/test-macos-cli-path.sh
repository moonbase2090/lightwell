#!/usr/bin/env bash
# Prove the macOS PATH shim with a fake app tree and a fresh shell.
# The stand-in for /usr/local/bin is a temporary directory, so this does not
# write the machine's real /usr/local/bin or edit shell profiles.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "macOS CLI path proof runs on Darwin; skipping on $(uname -s)"
  exit 0
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

if [[ ! -f dist/index.html ]]; then
  if [[ ! -d node_modules ]]; then
    echo "node_modules is missing; run npm ci before the macOS CLI path proof" >&2
    exit 1
  fi
  npm run build
fi

cargo test -p lightwell-app --bin lightwell --locked path_shim -- --test-threads=1

work=$(mktemp -d "${TMPDIR:-/tmp}/lightwell-cli-path.XXXXXX")
trap 'rm -rf "$work"' EXIT

write_stub() {
  local path="$1"
  local message="$2"
  mkdir -p "$(dirname -- "$path")"
  cat >"$path" <<EOF
#!/bin/sh
printf '%s\n' '${message}'
EOF
  chmod 755 "$path"
}

app="$work/Lightwell.app"
write_stub "$app/Contents/MacOS/lightwell" "lightwell-gui"
write_stub "$app/Contents/Resources/bin/lightwell" "lightwell-cli-stub"
system="$work/usr-local-bin"
mkdir -p "$system"

fresh_shell() {
  local home="$1"
  env -i HOME="$home" PATH="/usr/bin:/bin:$system:$home/.local/bin" /bin/sh -c 'command -v lightwell'
}

run_fresh() {
  local home="$1"
  env -i HOME="$home" PATH="/usr/bin:/bin:$system:$home/.local/bin" /bin/sh -c 'lightwell'
}

install_link() {
  local home="$1"
  local writable="$2"
  LIGHTWELL_SHIM_PROOF_APP="$app" \
    LIGHTWELL_SHIM_PROOF_SYSTEM="$system" \
    LIGHTWELL_SHIM_PROOF_HOME="$home" \
    LIGHTWELL_SHIM_PROOF_SYSTEM_WRITABLE="$writable" \
    cargo test -p lightwell-app --bin lightwell --locked \
      shell_proof_installs_resolvable_link -- --ignored --test-threads=1
}

home="$work/home"
mkdir -p "$home"
install_link "$home" 0

local_link="$home/.local/bin/lightwell"
if [[ -e "$system/lightwell" ]]; then
  echo "unwritable system bin still received a lightwell link" >&2
  exit 1
fi
if [[ ! -L "$local_link" ]]; then
  echo "expected a symlink at $local_link" >&2
  exit 1
fi
local_target=$(readlink "$local_link")
if [[ "$local_target" != "$app/Contents/Resources/bin/lightwell" ]]; then
  echo "local link points at $local_target" >&2
  exit 1
fi
resolved=$(fresh_shell "$home")
if [[ "$resolved" != "$local_link" ]]; then
  echo "fresh shell resolved $resolved, expected $local_link" >&2
  exit 1
fi
output=$(run_fresh "$home")
if [[ "$output" != "lightwell-cli-stub" ]]; then
  echo "fresh shell ran: $output" >&2
  exit 1
fi

system_home="$work/home-system"
mkdir -p "$system_home"
install_link "$system_home" 1

system_link="$system/lightwell"
if [[ ! -L "$system_link" ]]; then
  echo "expected a symlink at $system_link" >&2
  exit 1
fi
system_target=$(readlink "$system_link")
if [[ "$system_target" != "$app/Contents/Resources/bin/lightwell" ]]; then
  echo "system link points at $system_target" >&2
  exit 1
fi
resolved=$(fresh_shell "$system_home")
if [[ "$resolved" != "$system_link" ]]; then
  echo "fresh shell resolved $resolved, expected $system_link" >&2
  exit 1
fi
output=$(run_fresh "$system_home")
if [[ "$output" != "lightwell-cli-stub" ]]; then
  echo "fresh shell ran: $output" >&2
  exit 1
fi
if [[ -e "$system_home/.local/bin/lightwell" ]]; then
  echo "writable system bin also left a fallback link" >&2
  exit 1
fi

echo "macOS CLI path proof passed"
