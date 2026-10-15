#!/usr/bin/env bash
# Smoke the Linux release bundles headless:
#   - the AppImage extracts and its desktop app opens a window under Xvfb
#   - the rpm carries the desktop app
#   - the tarball installs, and its CLI reports the release version
#   - every bundled desktop binary embeds the viewer instead of loading the
#     dev server (issue #99)
set -euo pipefail

usage='Usage: smoke-linux-bundles.sh VERSION BUNDLE_DIR SCREENSHOT_DIR [DIST_DIR]'
version="${1:?$usage}"
bundle_dir="$(cd "${2:?$usage}" && pwd)"
screenshot_dir="${3:?$usage}"
mkdir -p "$screenshot_dir"
screenshot_dir="$(cd "$screenshot_dir" && pwd)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist_dir="$(cd "${4:-$script_dir/../../dist}" && pwd)"

appimage="$bundle_dir/Lightwell_${version}_amd64.AppImage"
rpm="$bundle_dir/Lightwell_${version}_x86_64.rpm"
deb="$bundle_dir/Lightwell_${version}_amd64.deb"
tarball="$bundle_dir/Lightwell_${version}_linux_x86_64.tar.gz"
for asset in "$appimage" "$rpm" "$deb" "$tarball"; do
  [[ -f "$asset" ]] || { printf 'missing release asset: %s\n' "$asset" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
binaries=()

# AppImage: extract without FUSE, then launch the bundled AppRun headless.
chmod +x "$appimage"
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
[[ -x "$work/squashfs-root/AppRun" ]] || { echo 'AppImage has no AppRun' >&2; exit 1; }
binaries+=("$work/squashfs-root/usr/bin/lightwell")
APPIMAGE_EXTRACT_AND_RUN=1 "$script_dir/capture-open-workspace.sh" \
  "$work/squashfs-root/AppRun" "$screenshot_dir/lightwell-appimage.png"

# rpm: the payload carries the desktop app. bsdtar reads every rpm payload
# compression, including zstd, which older rpm2cpio scripts cannot.
echo "Unpacking $rpm"
mkdir -p "$work/rpm"
bsdtar -xf "$rpm" -C "$work/rpm"
[[ -x "$work/rpm/usr/bin/lightwell" ]] || { echo 'rpm has no usr/bin/lightwell' >&2; exit 1; }
binaries+=("$work/rpm/usr/bin/lightwell")

# deb
echo "Unpacking $deb"
mkdir -p "$work/deb"
dpkg-deb -x "$deb" "$work/deb"
binaries+=("$work/deb/usr/bin/lightwell")

echo "Installing $tarball"
# tarball: install into a scratch prefix and check both binaries.
tar -C "$work" -xzf "$tarball"
PREFIX="$work/prefix" "$work/lightwell/install.sh"
reported="$("$work/prefix/bin/lightwell" --version)"
if [[ "$reported" != "lightwell $version" ]]; then
  printf 'tarball CLI reported %s, expected lightwell %s\n' "$reported" "$version" >&2
  exit 1
fi
printf 'tarball CLI: %s\n' "$reported"
[[ -x "$work/prefix/bin/lightwell-app" ]] || { echo 'tarball has no desktop app' >&2; exit 1; }
binaries+=("$work/prefix/bin/lightwell-app")

"$script_dir/check-embedded-viewer.sh" "$dist_dir" "${binaries[@]}"
echo 'Linux bundle smoke passed.'
