#!/usr/bin/env bash
# Pin packaging/arch/PKGBUILD to a published release: set pkgver and replace
# the tarball's SKIP with its sha256 from the release SHA256SUMS.
set -euo pipefail

version="${1:?Usage: update-pkgbuild.sh VERSION}"
pkgbuild="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/PKGBUILD"
tarball="lightwell-${version}-linux-x86_64.tar.gz"
sums="$(curl -fsSL "https://github.com/moonbase2090/lightwell/releases/download/v${version}/SHA256SUMS")"
sum="$(printf '%s\n' "$sums" | awk -v name="$tarball" '$2 == name { print $1 }')"
if [[ ! "$sum" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'no checksum for %s in the v%s SHA256SUMS\n' "$tarball" "$version" >&2
  exit 1
fi
python3 - "$pkgbuild" "$version" "$sum" <<'PY'
import re, sys
path, version, digest = sys.argv[1:]
text = open(path).read()
text = re.sub(r"^pkgver=.*$", f"pkgver={version}", text, flags=re.M)
text = re.sub(r"^pkgrel=.*$", "pkgrel=1", text, flags=re.M)
text = re.sub(r"^sha256sums=\('[^']*'", f"sha256sums=('{digest}'", text, flags=re.M)
open(path, "w").write(text)
PY
printf 'PKGBUILD pinned to %s (%s)\n' "$version" "$sum"
