#!/usr/bin/env bash
# Copy the release lightwell CLI into Lightwell.app before signing.
# The desktop binary stays at Contents/MacOS/lightwell. The CLI is
# Contents/Resources/bin/lightwell, so the names do not collide on a
# case-insensitive volume.
#
# Usage:
#   bundle-macos-cli.sh APP_PATH TARGET [TARGET...]
#   bundle-macos-cli.sh --from CLI_BINARY APP_PATH
#
# TARGET is a Rust triple such as aarch64-apple-darwin. One triple is copied.
# Two triples are combined with lipo. --from installs an existing binary and
# skips the Cargo build. Run the Cargo form from a Lightwell checkout.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "bundle-macos-cli.sh runs on macOS" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

usage() {
  echo "Usage: bundle-macos-cli.sh APP_PATH TARGET [TARGET...]" >&2
  echo "       bundle-macos-cli.sh --from CLI_BINARY APP_PATH" >&2
  exit 2
}

abs_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
    return
  fi
  local dir base
  dir=$(CDPATH= cd -- "$(dirname -- "$path")" && pwd)
  base=$(basename -- "$path")
  printf '%s/%s\n' "$dir" "$base"
}

from=""
app=""
targets=()
if [[ "${1:-}" == "--from" ]]; then
  [[ $# -eq 3 ]] || usage
  from="$2"
  app="$3"
elif [[ $# -ge 2 ]]; then
  app="$1"
  shift
  targets=("$@")
else
  usage
fi

if [[ ! -d "$app" ]]; then
  echo "Lightwell.app is missing: $app" >&2
  exit 1
fi
app=$(abs_path "$app")
gui="$app/Contents/MacOS/lightwell"
if [[ ! -x "$gui" ]]; then
  echo "Lightwell.app is missing its desktop binary: $gui" >&2
  exit 1
fi

if [[ -n "$from" ]]; then
  if [[ ! -f "$from" || ! -x "$from" ]]; then
    echo "CLI binary missing or not executable: $from" >&2
    exit 1
  fi
  from=$(abs_path "$from")
  bins=("$from")
else
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
  target_dir="${LIGHTWELL_CLI_TARGET_DIR:-$repo_root/target/macos-cli}"
  bins=()
  for triple in "${targets[@]}"; do
    case "$triple" in
      aarch64-apple-darwin|x86_64-apple-darwin) ;;
      *)
        echo "unsupported macOS CLI target: $triple" >&2
        exit 2
        ;;
    esac
    (
      cd "$repo_root"
      cargo build --release --locked -p lightwell-cli --target "$triple" --target-dir "$target_dir"
    )
    bin="$target_dir/$triple/release/lightwell"
    if [[ ! -x "$bin" ]]; then
      echo "CLI build missing: $bin" >&2
      exit 1
    fi
    bins+=("$bin")
  done
fi

stage=$(mktemp "${TMPDIR:-/tmp}/lightwell-cli.XXXXXX")
cleanup() {
  rm -f "$stage"
}
trap cleanup EXIT
rm -f "$stage"

if [[ ${#bins[@]} -eq 1 ]]; then
  cp "${bins[0]}" "$stage"
else
  lipo -create -output "$stage" "${bins[@]}"
  lipo "$stage" -verify_arch arm64 x86_64
fi
chmod 0755 "$stage"
"$script_dir/check-macos-minimum.sh" "$stage" "${MACOSX_DEPLOYMENT_TARGET:-11.0}"

dest_dir="$app/Contents/Resources/bin"
mkdir -p "$dest_dir"
dest="$dest_dir/lightwell"
install -m 0755 "$stage" "$dest"

gui_id=$(stat -f '%d:%i' "$gui")
cli_id=$(stat -f '%d:%i' "$dest")
if [[ "$gui_id" == "$cli_id" ]]; then
  echo "bundled CLI is the same file as the desktop binary" >&2
  exit 1
fi

echo "Bundled lightwell CLI at $dest"
