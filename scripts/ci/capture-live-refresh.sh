#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-live-refresh.sh <app-binary> <artifact-directory>}"
artifact_dir="${2:?Usage: capture-live-refresh.sh <app-binary> <artifact-directory>}"

if [[ ! -x "$app_path" ]]; then
  printf 'Lightwell app binary is missing or not executable: %s\n' "$app_path" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
if ! command -v tesseract >/dev/null 2>&1; then
  printf 'Live refresh capture requires tesseract-ocr.\n' >&2
  exit 1
fi
workspace="$(mktemp -d)"
config_home="$(mktemp -d)"
data_home="$(mktemp -d)"
app_log="$artifact_dir/app.log"
trap 'rm -rf "$workspace" "$config_home" "$data_home"' EXIT

mkdir -p "$workspace/src" "$config_home/com.moonbase2090.lightwell"
cat >"$workspace/Cargo.toml" <<'EOF'
[package]
name = "live-refresh-fixture"
version = "0.1.0"
edition = "2021"
EOF
printf 'pub mod before;\n' >"$workspace/src/lib.rs"
printf 'pub fn value() -> u8 { 1 }\n' >"$workspace/src/before.rs"
node - "$workspace" "$config_home/com.moonbase2090.lightwell/recent-workspaces.json" <<'NODE'
const fs = require("node:fs");
const [workspace, configPath] = process.argv.slice(2);
fs.writeFileSync(configPath, JSON.stringify([{ id: workspace, label: "Live refresh fixture" }]));
NODE

XDG_CONFIG_HOME="$config_home" XDG_DATA_HOME="$data_home" xvfb-run -a --server-args='-screen 0 1440x900x24' \
  bash -e -u -o pipefail -c '
    app_path="$1"
    artifact_dir="$2"
    workspace="$3"
    app_log="$4"

    "$app_path" >"$app_log" 2>&1 &
    app_pid=$!
    stop_app() {
      kill "$app_pid" 2>/dev/null || true
      wait "$app_pid" 2>/dev/null || true
    }
    trap stop_app EXIT

    window_id=""
    for _ in $(seq 1 60); do
      window_id="$(xdotool search --onlyvisible --name Lightwell 2>/dev/null | sed -n "1p" || true)"
      if [[ -n "$window_id" ]]; then
        break
      fi
      if ! kill -0 "$app_pid" 2>/dev/null; then
        cat "$app_log" >&2
        exit 1
      fi
      sleep 1
    done

    if [[ -z "$window_id" ]]; then
      cat "$app_log" >&2
      printf "Lightwell did not open a visible window.\n" >&2
      exit 1
    fi

    xdotool windowsize "$window_id" 1280 850
    wait_for_label() {
      local phase="$1" expected="$2" deadline=$((SECONDS + 60))
      while (( SECONDS < deadline )); do
        if ! kill -0 "$app_pid" 2>/dev/null; then
          cat "$app_log" >&2
          printf "Lightwell exited while waiting for %s.\n" "$expected" >&2
          return 1
        fi
        import -window "$window_id" "$artifact_dir/$phase.png"
        # Isolate the default map pane, excluding search, counters and source text.
        convert "$artifact_dir/$phase.png" -crop 960x470+0+154 +repage -colorspace Gray -threshold 55% -negate -resize 200% "$artifact_dir/ocr.png"
        tesseract "$artifact_dir/ocr.png" stdout --psm 11 >"$artifact_dir/$phase.txt" 2>"$artifact_dir/ocr.log"
        if grep -Eiq "(^|[^[:alnum:]_])${expected}([^[:alnum:]_]|$)" "$artifact_dir/$phase.txt"; then
          return 0
        fi
        sleep 1
      done
      cat "$app_log" >&2
      printf "The live map did not show the expected %s label during %s.\n" "$expected" "$phase" >&2
      return 1
    }

    wait_for_label ready CRATE
    # The default depth hides Rust modules. Search brings their parent into scope.
    xdotool key ctrl+k
    xdotool type --clearmodifiers --delay 45 before
    xdotool key Return
    wait_for_label before before
    printf "pub fn value() -> u8 { 2 }\\n" >"$workspace/src/after.rs"
    printf "pub mod before;\\npub mod after;\\n" >"$workspace/src/lib.rs"
    wait_for_label after after

    read -r width height < <(identify -format "%w %h\\n" "$artifact_dir/after.png")
    if (( width < 800 || height < 500 )); then
      printf "Screenshot is too small: %sx%s\\n" "$width" "$height" >&2
      exit 1
    fi
    printf "The built app showed module before, then module after following a Rust source edit.\n"
  ' lightwell-live-refresh "$app_path" "$artifact_dir" "$workspace" "$app_log"
