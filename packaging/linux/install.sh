#!/bin/sh
# Install Lightwell from the portable Linux tarball.
#   ./install.sh              installs under /usr/local (run with sudo)
#   PREFIX=$HOME/.local ./install.sh   installs for the current user
#   ./install.sh --uninstall  removes a previous install from PREFIX
set -eu

PREFIX="${PREFIX:-/usr/local}"
DESTDIR="${DESTDIR:-}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$DESTDIR$PREFIX"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$root/bin/lightwell" "$root/bin/lightwell-app" \
    "$root/share/applications/lightwell.desktop" \
    "$root/share/icons/hicolor/128x128/apps/lightwell.png"
  rm -rf "$root/share/doc/lightwell"
  echo "Removed Lightwell from $root"
  exit 0
fi

install -d "$root/bin" "$root/share/doc/lightwell"
install -m 0755 "$here/bin/lightwell" "$root/bin/lightwell"
if [ -f "$here/bin/lightwell-app" ]; then
  install -d "$root/share/applications" "$root/share/icons/hicolor/128x128/apps"
  install -m 0755 "$here/bin/lightwell-app" "$root/bin/lightwell-app"
  install -m 0644 "$here/share/icons/lightwell.png" "$root/share/icons/hicolor/128x128/apps/lightwell.png"
  sed "s|@BINDIR@|$PREFIX/bin|" "$here/share/applications/lightwell.desktop" \
    > "$root/share/applications/lightwell.desktop"
  chmod 0644 "$root/share/applications/lightwell.desktop"
fi
install -m 0644 "$here/LICENSE" "$here/README.md" "$root/share/doc/lightwell/"

echo "Installed Lightwell to $root"
echo "  command line: $PREFIX/bin/lightwell"
if [ -f "$here/bin/lightwell-app" ]; then
  echo "  desktop app:  $PREFIX/bin/lightwell-app (needs WebKitGTK 4.1)"
fi
