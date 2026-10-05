#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: smoke-project-notes.sh <lightwell-binary>" >&2
  exit 2
fi

cli_path=$1
case "$cli_path" in
  /*) ;;
  *) cli_path="$(cd "$(dirname "$cli_path")" && pwd)/$(basename "$cli_path")" ;;
esac

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/lightwell-notes-smoke.XXXXXX")
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM
project="$temporary_root/project"
mkdir -p "$project/src"
cat > "$project/Cargo.toml" <<'TOML'
[package]
name = "notes-smoke"
version = "0.1.0"
edition = "2021"
TOML
printf 'pub fn before() -> u8 { 1 }\n' > "$project/src/lib.rs"

empty_output=$(cd "$project" && "$cli_path" notes list)
printf '%s\n' "$empty_output" | grep -F 'No project notes.' >/dev/null
test ! -e "$project/.lightwell"

(cd "$project" && "$cli_path" notes set 'module:notes-smoke:crate root' 'Keep this note')
test -f "$project/.lightwell/notes.json"
grep -F '"sourceFingerprint"' "$project/.lightwell/notes.json" >/dev/null

current_output=$(cd "$project" && "$cli_path" notes list)
printf '%s\n' "$current_output" | grep -F '[current] module:notes-smoke:crate root' >/dev/null
printf 'pub fn before() -> u8 { 1 }\npub fn after() -> u8 { 2 }\n' > "$project/src/lib.rs"
stale_output=$(cd "$project" && "$cli_path" notes list)
printf '%s\n' "$stale_output" | grep -F '[stale] module:notes-smoke:crate root' >/dev/null
printf '%s\n' "$stale_output" | grep -F 'Keep this note' >/dev/null

(cd "$project" && "$cli_path" notes rm 'module:notes-smoke:crate root')
removed_output=$(cd "$project" && "$cli_path" notes list)
printf '%s\n' "$removed_output" | grep -F 'No project notes.' >/dev/null
echo "Project notes smoke passed: first save, current status, stale retention, and explicit removal."
