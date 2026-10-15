#!/usr/bin/env bash
# Build lightwell-<version>-linux-<arch>.tar.gz from a CLI binary and an
# optional desktop app binary.
set -euo pipefail

usage='Usage: package-linux-tarball.sh VERSION ARCH CLI_BINARY [APP_BINARY|-] OUTPUT_DIR'
version="${1:?$usage}"
arch="${2:?$usage}"
cli="${3:?$usage}"
app="${4:?$usage}"
output_dir="${5:?$usage}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$arch" in
  x86_64|aarch64) ;;
  *) printf 'unsupported tarball architecture: %s\n' "$arch" >&2; exit 2 ;;
esac

name="lightwell-$version-linux-$arch"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The archive unpacks to lightwell/; the asset name carries the version.
stage="$work/lightwell"
install -d "$stage/bin"
install -m 0755 "$cli" "$stage/bin/lightwell"
if [[ "$app" != - ]]; then
  install -d "$stage/share/applications" "$stage/share/icons"
  install -m 0755 "$app" "$stage/bin/lightwell-app"
  install -m 0644 "$repo_root/packaging/linux/lightwell.desktop" "$stage/share/applications/lightwell.desktop"
  install -m 0644 "$repo_root/crates/lightwell-app/icons/128x128.png" "$stage/share/icons/lightwell.png"
fi
install -m 0755 "$repo_root/packaging/linux/install.sh" "$stage/install.sh"
install -m 0644 "$repo_root/LICENSE" "$repo_root/README.md" "$stage/"

mkdir -p "$output_dir"
tar -C "$work" --owner=0 --group=0 --numeric-owner -czf "$output_dir/$name.tar.gz" lightwell
printf '%s\n' "$output_dir/$name.tar.gz"
