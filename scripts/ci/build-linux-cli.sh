#!/usr/bin/env bash
set -euo pipefail

target="${1:?Usage: build-linux-cli.sh TARGET}"
case "$target" in
  x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu) ;;
  *)
    printf 'unsupported Linux CLI target: %s\n' "$target" >&2
    exit 2
    ;;
esac

CARGO_ZIGBUILD_ZIG_PATH=zig cargo zigbuild \
  --release --locked -p lightwell-cli \
  --target "$target.2.28"
