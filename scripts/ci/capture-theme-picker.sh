#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-theme-picker.sh <app-binary> <artifact-directory>}"
artifact_dir="${2:?Usage: capture-theme-picker.sh <app-binary> <artifact-directory>}"

if [[ ! -x "$app_path" ]]; then
  printf 'Lightwell app binary is missing or not executable: %s\n' "$app_path" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
workspace="$(mktemp -d)"
config_home="$(mktemp -d)"
data_home="$(mktemp -d)"
app_log="$(mktemp)"
trap 'rm -rf "$workspace" "$config_home" "$data_home"; rm -f "$app_log"' EXIT

mkdir -p "$workspace/src" "$config_home/com.moonbase2090.lightwell"
cat >"$workspace/Cargo.toml" <<'EOF'
[package]
name = "theme-proof"
version = "0.1.0"
edition = "2021"
EOF
cat >"$workspace/src/lib.rs" <<'EOF'
pub mod lightwell_theme_proof {
    pub fn theme() -> &'static str {
        "blueprint"
    }
}
EOF
node - "$workspace" "$config_home/com.moonbase2090.lightwell/recent-workspaces.json" <<'NODE'
const fs = require("node:fs");
const [workspace, recentPath] = process.argv.slice(2);
fs.writeFileSync(recentPath, JSON.stringify([{ id: workspace, label: "Theme proof" }]));
NODE

XDG_CONFIG_HOME="$config_home" XDG_DATA_HOME="$data_home" xvfb-run -a --server-args='-screen 0 1440x900x24' \
  bash -e -u -o pipefail -c '
    app_path="$1"
    artifact_dir="$2"
    app_log="$3"

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
      if [[ -n "$window_id" ]]; then break; fi
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

    sleep 8
    window_width="$(xdotool getwindowgeometry "$window_id" | awk -F"[ x+]" "/Geometry:/ { print \$2 }")"
    settings_x=$((window_width - 164))

    capture_theme() {
      theme_name="$1"
      down_count="$2"
      xdotool mousemove --window "$window_id" "$settings_x" 32 click 1
      sleep 1
      xdotool key Tab
      xdotool key Home
      for _ in $(seq 1 "$down_count"); do xdotool key Down; done
      xdotool key Return
      sleep 2
      import -window "$window_id" "$artifact_dir/theme-settings-$theme_name.png"
      xdotool key Escape
      sleep 2
      import -window "$window_id" "$artifact_dir/theme-$theme_name.png"
    }

    capture_theme system 0
    capture_theme dark 1
    capture_theme light 2
    capture_theme blueprint 3

    for image in system dark light blueprint; do
      read -r width height < <(identify -format "%w %h\n" "$artifact_dir/theme-$image.png")
      if (( width < 800 || height < 500 )); then
        printf "Theme screenshot is too small: %sx%s\n" "$width" "$height" >&2
        exit 1
      fi
    done
    for pair in "dark light" "light blueprint"; do
      read -r left right <<<"$pair"
      changed_pixels="$(compare -metric AE "$artifact_dir/theme-$left.png" "$artifact_dir/theme-$right.png" null: 2>&1 || true)"
      if [[ ! "$changed_pixels" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]] || (( ${changed_pixels%%.*} < 20000 )); then
        printf "Themes %s and %s were not visibly different (%s changed pixels).\n" "$left" "$right" "$changed_pixels" >&2
        exit 1
      fi
    done
    printf "The built app applied Follow system, Dark, Light, and Blueprint from Settings.\n"
  ' lightwell-theme-picker "$app_path" "$artifact_dir" "$app_log"
