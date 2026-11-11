#!/usr/bin/env bash
set -euo pipefail
app_path="$(realpath "${1:?Usage: capture-definitions.sh <desktop-binary> <artifacts> [before]}")"
mkdir -p "${2:?Artifact directory required}"
artifacts="$(realpath "$2")"
phase="${3:-after}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$app_path" "$work/lightwell-desktop"
mkdir -p "$work/definition-fixture/src" "$work/config/com.moonbase2090.lightwell" "$work/data" "$work/cache"
cat > "$work/definition-fixture/Cargo.toml" <<'TOML'
[package]
name = "definition-fixture"
version = "0.1.0"
edition = "2021"
[[bin]]
name = "main"
path = "src/main.rs"
TOML
cat > "$work/definition-fixture/src/main.rs" <<'RUST'
mod helpers;
fn main() {
    helpers::calculate();
    duplicate();
}
fn duplicate() {}
RUST
cat > "$work/definition-fixture/src/helpers.rs" <<'RUST'
// Helpers
// Definition navigation fixture
//
pub fn calculate() -> i32 { 7 }
pub fn duplicate() {}
RUST
git -C "$work/definition-fixture" init -q
git -C "$work/definition-fixture" add .
git -C "$work/definition-fixture" -c user.name='Moonbase 2090' -c user.email='322824348+mb2090@users.noreply.github.com' commit -qm 'Create definition navigation fixture'
node - "$work" <<'NODE'
const fs = require("node:fs");
const root = process.argv[2];
fs.writeFileSync(`${root}/config/com.moonbase2090.lightwell/recent-workspaces.json`, JSON.stringify([{ id: `${root}/definition-fixture`, label: "Definition fixture" }]));
NODE
OMP_THREAD_LIMIT=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache" \
  xvfb-run -a --server-args='-screen 0 1440x900x24' bash -e -u -o pipefail -c '
    work="$1"; artifacts="$2"; phase="$3"
    "$work/lightwell-desktop" > "$artifacts/app.log" 2>&1 &
    app_pid=$!
    trap '\''kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true'\'' EXIT
    window=""
    for _ in $(seq 1 90); do
      window="$(xdotool search --onlyvisible --name Lightwell 2>/dev/null | head -1 || true)"
      [[ -z "$window" ]] || break
      kill -0 "$app_pid" 2>/dev/null || { cat "$artifacts/app.log" >&2; exit 1; }
      sleep 1
    done
    [[ -n "$window" ]] || { cat "$artifacts/app.log" >&2; exit 1; }
    xdotool windowsize "$window" 1440 900
    capture() {
      local name="$1"
      import -window "$window" "$artifacts/$name.png"
      convert "$artifacts/$name.png" -crop 320x792+1120+108 +repage -resize 200% -colorspace Gray "$artifacts/source-ocr.png"
      tesseract "$artifacts/source-ocr.png" stdout --psm 6 2>/dev/null > "$artifacts/$name.txt"
    }
    wait_for_source() {
      local name="$1" pattern="$2"
      for _ in $(seq 1 60); do
        capture "$name"
        if grep -Eiq "$pattern" "$artifacts/$name.txt"; then return 0; fi
        kill -0 "$app_pid" 2>/dev/null || break
        sleep 1
      done
      cat "$artifacts/app.log" >&2
      printf "Source capture did not show %s\n" "$pattern" >&2
      return 1
    }
    # Wait for extraction before using the real Atlas outline.
    for _ in $(seq 1 90); do
      import -window "$window" "$artifacts/loading.png"
      convert "$artifacts/loading.png" -crop 1440x160+0+0 +repage -resize 200% -colorspace Gray "$artifacts/header-ocr.png"
      tesseract "$artifacts/header-ocr.png" stdout --psm 6 2>/dev/null > "$artifacts/header.txt"
      if grep -Eiq "ready" "$artifacts/header.txt"; then break; fi
      sleep 1
    done
    grep -Eiq "ready" "$artifacts/header.txt"
    select_main() {
      xdotool mousemove --window "$window" 140 286 click 1
      xdotool key ctrl+a
      xdotool type --clearmodifiers main
      sleep 1
      xdotool key Tab Tab End Return
    }
    goto_word() {
      xdotool mousemove --window "$window" 1300 360 click 1
      xdotool key ctrl+g
      sleep 0.3
      xdotool key ctrl+a
      xdotool type --clearmodifiers "$1"
      xdotool key Return
      xdotool key F12
    }
    select_main
    wait_for_source definition-call "main.rs"
    goto_word ":3:17"
    if [[ "$phase" == before ]]; then
      sleep 2
      capture definition-before
      grep -Eiq "main.rs" "$artifacts/definition-before.txt"
      printf "Baseline F12 left the caller open.\n"
      exit 0
    fi
    wait_for_source definition-after "helpers.rs"
    grep -Eiq "LINE[[:space:]]+4" "$artifacts/definition-after.txt"
    grep -Eiq "COLUMN[[:space:]]+8" "$artifacts/definition-after.txt"
    select_main
    wait_for_source definition-main "main.rs"
    goto_word ":4:8"
    sleep 1
    capture definition-ambiguous
    grep -Eiq "main.rs" "$artifacts/definition-ambiguous.txt"
    printf "Definition navigation opened helpers.rs at line 4 column 8; ambiguous name left main.rs open.\n"
  ' lightwell-definition-proof "$work" "$artifacts" "$phase"
