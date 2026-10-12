#!/usr/bin/env bash
# Exercises the release check scripts against real binaries, bundles, and
# packages: each must accept a good input and refuse a deliberately bad one
# with the expected message. macOS covers the minimum-version and unsigned-app
# checks; Linux covers the .deb GLIBC check.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/lightwell-release-checks.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failures=0

# expect_pass NAME EXPECTED-STDOUT-TEXT COMMAND...
expect_pass() {
  local name="$1" text="$2" output
  shift 2
  if ! output=$("$@" 2>&1); then
    printf 'FAIL %s: exited non-zero:\n%s\n' "$name" "$output" >&2
    failures=$((failures + 1))
  elif [[ "$output" != *"$text"* ]]; then
    printf 'FAIL %s: output lacks "%s":\n%s\n' "$name" "$text" "$output" >&2
    failures=$((failures + 1))
  else
    printf 'ok   %s\n' "$name"
  fi
}

# expect_refusal NAME EXPECTED-STDERR-TEXT COMMAND...
expect_refusal() {
  local name="$1" text="$2" output
  shift 2
  if output=$("$@" 2>&1); then
    printf 'FAIL %s: accepted a bad input:\n%s\n' "$name" "$output" >&2
    failures=$((failures + 1))
  elif [[ "$output" != *"$text"* ]]; then
    printf 'FAIL %s: refused for the wrong reason, expected "%s":\n%s\n' "$name" "$text" "$output" >&2
    failures=$((failures + 1))
  else
    printf 'ok   %s\n' "$name"
  fi
}

test_macos() {
  printf 'int main(void) { return 0; }\n' > "$work/main.c"
  cc -mmacosx-version-min=11.0 -o "$work/min11" "$work/main.c"
  cc -mmacosx-version-min=12.0 -o "$work/min12" "$work/main.c"

  make_app() { # NAME MINIMUM
    local app="$work/$1.app"
    mkdir -p "$app/Contents/MacOS"
    cp "$work/min11" "$app/Contents/MacOS/app"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>app</string>
<key>CFBundleIdentifier</key><string>com.example.$1</string>
<key>LSMinimumSystemVersion</key><string>$2</string>
</dict></plist>
PLIST
  }
  make_app plist11 11.0
  make_app plist12 12.0

  expect_pass "binary with minos 11.0 is accepted" "minimum macOS version: 11.0" \
    "$script_dir/check-macos-minimum.sh" "$work/min11"
  expect_refusal "binary with minos 12.0 is refused" "expected a macOS 11.0 minimum, found 12.0" \
    "$script_dir/check-macos-minimum.sh" "$work/min12"
  expect_pass "app with LSMinimumSystemVersion 11.0 is accepted" "minimum macOS version: 11.0" \
    "$script_dir/check-macos-minimum.sh" "$work/plist11.app"
  expect_refusal "app with LSMinimumSystemVersion 12.0 is refused" "expected a macOS 11.0 minimum, found 12.0" \
    "$script_dir/check-macos-minimum.sh" "$work/plist12.app"
  expect_refusal "missing binary is refused" "does not exist" \
    "$script_dir/check-macos-minimum.sh" "$work/absent"

  expect_pass "unsigned app is accepted" "is unsigned, as expected" \
    "$script_dir/check-unsigned-macos-app.sh" "$work/plist11.app"
  codesign --force --sign - "$work/plist11.app" > /dev/null 2>&1
  expect_refusal "ad-hoc signed app is refused" "codesign verified the bundle" \
    "$script_dir/check-unsigned-macos-app.sh" "$work/plist11.app"
  expect_refusal "missing app is refused" "App bundle does not exist" \
    "$script_dir/check-unsigned-macos-app.sh" "$work/absent.app"
}

test_linux() {
  # A normal gcc link on glibc 2.34+ pulls in __libc_start_main@GLIBC_2.34, so
  # both fixtures skip the C runtime start files and differ only in the one
  # libc symbol they import: _exit (GLIBC_2.2.5 or 2.17) versus close_range
  # (GLIBC_2.34, newer than the 2.28 floor).
  cat > "$work/old.c" <<'C'
#include <unistd.h>
void _start(void) { _exit(0); }
C
  cat > "$work/new.c" <<'C'
#define _GNU_SOURCE
#include <unistd.h>
void _start(void) { _exit(close_range(1000, 1001, 0) < 0 ? 1 : 0); }
C
  cc -nostartfiles -o "$work/old" "$work/old.c"
  cc -nostartfiles -o "$work/new" "$work/new.c"

  make_deb() { # NAME BINARY INSTALL-NAME
    local root="$work/$1-root"
    mkdir -p "$root/DEBIAN" "$root/usr/bin"
    printf 'Package: lightwell-test\nVersion: 0.0.0\nArchitecture: all\nMaintainer: test <test@example.com>\nDescription: release check fixture\n' > "$root/DEBIAN/control"
    install -m 755 "$2" "$root/usr/bin/$3"
    mkdir -p "$work/$1"
    dpkg-deb --build "$root" "$work/$1/$1.deb" > /dev/null
  }
  make_deb good "$work/old" lightwell
  make_deb newer "$work/new" lightwell
  make_deb misnamed "$work/old" other-tool
  mkdir "$work/empty"

  expect_pass "package within GLIBC 2.28 is accepted" "GLIBC maximum:" \
    "$script_dir/check-deb-glibc.sh" "$work/good/good.deb"
  expect_pass "directory holding the package is accepted" "GLIBC maximum:" \
    "$script_dir/check-deb-glibc.sh" "$work/good"
  expect_refusal "package needing GLIBC 2.34 is refused" "requires GLIBC_2.34; the maximum allowed is GLIBC_2.28" \
    "$script_dir/check-deb-glibc.sh" "$work/newer/newer.deb"
  expect_pass "raised ceiling accepts the same package" "GLIBC maximum: 2.34" \
    "$script_dir/check-deb-glibc.sh" "$work/newer/newer.deb" 2.34
  expect_refusal "package without a lightwell binary is refused" "No lightwell executable" \
    "$script_dir/check-deb-glibc.sh" "$work/misnamed/misnamed.deb"
  expect_refusal "directory without a package is refused" "No .deb package found" \
    "$script_dir/check-deb-glibc.sh" "$work/empty"
}

test_release_notes_from_tag() {
  local repo="$work/tag-notes" notes="$work/notes.md"
  git init -q "$repo"
  (
    cd "$repo"
    git config user.email 'test@example.com'
    git config user.name 'test'
    printf 'fixture\n' > f
    git add f
    git commit -qm 'fixture'
    git tag -a v0.1.0 -m "$(cat <<'EOF'
Lightwell 0.1.0

Ship notes here.

-----BEGIN SSH SIGNATURE-----
inline signature lines must not appear in release notes
-----END SSH SIGNATURE-----
EOF
)"
    "$script_dir/release-notes-from-tag.sh" v0.1.0 "$notes"
  )
  if grep -q 'BEGIN SSH SIGNATURE' "$notes"; then
    printf 'FAIL release-notes-from-tag: SSH signature block leaked into release notes\n' >&2
    failures=$((failures + 1))
  elif ! grep -q 'Ship notes here.' "$notes"; then
    printf 'FAIL release-notes-from-tag: expected tag message body in release notes\n' >&2
    failures=$((failures + 1))
  else
    printf 'ok   release-notes-from-tag strips SSH signature block\n'
  fi
}

test_release_notes_from_tag

case "$(uname -s)" in
  Darwin) test_macos ;;
  Linux) test_linux ;;
  *) printf 'Unsupported platform: %s\n' "$(uname -s)" >&2; exit 1 ;;
esac

if ((failures > 0)); then
  printf '%d release check test(s) failed\n' "$failures" >&2
  exit 1
fi
