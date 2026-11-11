#!/usr/bin/env bash
set -euo pipefail
app_path="$(realpath "${1:?Usage: capture-source-files.sh <desktop-binary> <artifacts> [before]}")"
mkdir -p "${2:?Artifact directory required}"
artifacts="$(realpath "$2")"
phase="${3:-after}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$app_path" "$work/lightwell-desktop"
mkdir -p "$work/source-files-fixture/src" "$work/config/com.moonbase2090.lightwell" "$work/data" "$work/cache"
cat > "$work/source-files-fixture/Cargo.toml" <<'TOML'
[package]
name = "source-files-fixture"
version = "0.1.0"
edition = "2021"
[[bin]]
name = "main"
path = "src/main.rs"
TOML
cat > "$work/source-files-fixture/src/main.rs" <<'RUST'
mod helpers;
fn main() {
    helpers::calculate();
    duplicate();
}
fn duplicate() {}
RUST
cat > "$work/source-files-fixture/src/helpers.rs" <<'RUST'
// Helpers
// Source file navigation fixture
//
pub fn calculate() -> i32 { 7 }
pub fn duplicate() {}
RUST
git -C "$work/source-files-fixture" init -q
git -C "$work/source-files-fixture" add .
git -C "$work/source-files-fixture" -c user.name='Moonbase 2090' -c user.email='322824348+mb2090@users.noreply.github.com' commit -qm 'Create source file navigation fixture'
cat > "$work/editor-probe" <<'PROBE'
#!/usr/bin/env bash
printf '%s\n' "$1" > "$2"
PROBE
chmod +x "$work/editor-probe"
node - "$work" "$artifacts" <<'NODE'
const fs = require("node:fs");
const root = process.argv[2];
fs.writeFileSync(`${root}/config/com.moonbase2090.lightwell/editor-settings.json`, JSON.stringify({ commandTemplate: `"${root}/editor-probe" {file} "${process.argv[3]}/editor-target.txt"` }));
fs.writeFileSync(`${root}/config/com.moonbase2090.lightwell/recent-workspaces.json`, JSON.stringify([{ id: `${root}/source-files-fixture`, label: "Source files fixture" }]));
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
      local name="$1" pattern="$2" content="${3:-.}"
      for _ in $(seq 1 60); do
        capture "$name"
        if grep -Eiq "$pattern" "$artifacts/$name.txt" && grep -Eiq "$content" "$artifacts/$name.txt"; then return 0; fi
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
    select_main
    wait_for_source source-files-primary "main.rs" "mod helpers"
    if [[ "$phase" == before ]]; then
      if grep -Eiq "Source file" "$artifacts/source-files-primary.txt"; then
        printf "Baseline unexpectedly has a source file selector\n" >&2
        exit 1
      fi
      printf "Baseline has no block source-file selector.\n"
      exit 0
    fi
    grep -Eiq "Source file" "$artifacts/source-files-primary.txt"
    xdotool mousemove --window "$window" 1260 232 click 1
    sleep 0.5
    xdotool key End
    sleep 0.2
    xdotool key Return
    wait_for_source source-files-helper "helpers.rs" "pub fn calculate"
    xdotool mousemove --window "$window" 1270 278 click 1
    for _ in $(seq 1 30); do
      [[ ! -s "$artifacts/editor-target.txt" ]] || break
      sleep 1
    done
    grep -Eq "/src/helpers.rs$" "$artifacts/editor-target.txt"
    xdotool mousemove --window "$window" 1260 232 click 1
    sleep 0.5
    xdotool key Home
    sleep 0.2
    xdotool key Return
    wait_for_source source-files-return "main.rs" "mod helpers"
    grep -Eiq "LINE[[:space:]]+1" "$artifacts/source-files-return.txt"
    printf "Block source files switched main.rs -> helpers.rs -> main.rs; external editor received helpers.rs.\n"
  ' lightwell-source-files-proof "$work" "$artifacts" "$phase"
