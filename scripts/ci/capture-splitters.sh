#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-splitters.sh <app-binary> <artifact-directory>}"
artifact_dir="${2:?Usage: capture-splitters.sh <app-binary> <artifact-directory>}"

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
name = "splitter-proof"
version = "0.1.0"
edition = "2021"
EOF
cat >"$workspace/src/lib.rs" <<'EOF'
pub mod splitter_proof {
    pub fn project() -> &'static str {
        "architecture"
    }
}
EOF
node - "$workspace" "$config_home/com.moonbase2090.lightwell/recent-workspaces.json" <<'NODE'
const fs = require("node:fs");
const [workspace, recentPath] = process.argv.slice(2);
fs.writeFileSync(recentPath, JSON.stringify([{ id: workspace, label: "Splitter proof" }]));
NODE

XDG_CONFIG_HOME="$config_home" XDG_DATA_HOME="$data_home" xvfb-run -a --server-args='-screen 0 1600x1000x24' \
  bash -e -u -o pipefail -s -- "$app_path" "$artifact_dir" "$app_log" <<'BASH'
app_path="$1"
artifact_dir="$2"
app_log="$3"
app_pid=""
window_id=""

stop_app() {
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
    app_pid=""
  fi
}
finish() {
  local status=$?
  trap - EXIT
  cp "$app_log" "$artifact_dir/app-final.log" 2>/dev/null || true
  stop_app
  exit "$status"
}
trap finish EXIT

start_app() {
  : >"$app_log"
  "$app_path" >"$app_log" 2>&1 &
  app_pid=$!
  window_id=""
  for _ in $(seq 1 60); do
    window_id="$(xdotool search --onlyvisible --name Lightwell 2>/dev/null | sed -n '1p' || true)"
    if [[ -n "$window_id" ]]; then break; fi
    if ! kill -0 "$app_pid" 2>/dev/null; then
      cat "$app_log" >&2
      exit 1
    fi
    sleep 1
  done
  if [[ -z "$window_id" ]]; then
    cat "$app_log" >&2
    printf 'Lightwell did not open a visible window.\n' >&2
    exit 1
  fi
  xdotool windowsize --sync "$window_id" 1440 900
  xdotool windowmove "$window_id" 0 0
  sleep 7
}

capture() {
  local name="$1"
  import -window "$window_id" "$artifact_dir/$name.png"
  dimensions="$(identify -format '%wx%h' "$artifact_dir/$name.png")"
  if [[ "$dimensions" != '1440x900' ]]; then
    printf 'Expected a 1440x900 screenshot, found %s (%s).\n' "$dimensions" "$name" >&2
    exit 1
  fi
  colors="$(identify -format '%k' "$artifact_dir/$name.png")"
  if [[ ! "$colors" =~ ^[0-9]+$ ]] || (( colors < 500 )); then
    printf 'The %s screenshot appears blank (%s unique colors).\n' "$name" "$colors" >&2
    exit 1
  fi
}

pixel_diff_count() {
  local raw_count rounded_count
  raw_count="$(compare -metric AE "$1" "$2" null: 2>&1 || true)"
  if [[ "$raw_count" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
    printf -v rounded_count '%.0f' "$raw_count"
    printf '%s' "$rounded_count"
  else
    printf '0'
  fi
}

start_app
# Default split positions for the fixed 1440x900 CI window.
outer_x=1117
outer_y=525
inner_x=550
inner_y=672
capture before

xdotool mousemove --window "$window_id" "$outer_x" "$outer_y" mousedown 1
xdotool mousemove --sync --window "$window_id" 995 "$outer_y"
sleep 0.25
xdotool mouseup 1
sleep 0.5
xdotool mousemove --window "$window_id" "$inner_x" "$inner_y" mousedown 1
xdotool mousemove --sync --window "$window_id" "$inner_x" 580
sleep 0.25
xdotool mouseup 1
xdotool mousemove --window "$window_id" 2 2
sleep 1
capture after

cp "$app_log" "$artifact_dir/app-initial.log"
stop_app
start_app
xdotool mousemove --window "$window_id" 2 2
sleep 2
capture restored
stop_app

drag_pixels="$(pixel_diff_count "$artifact_dir/before.png" "$artifact_dir/after.png")"
if (( drag_pixels < 50000 )); then
  cat "$app_log" >&2
  printf 'Dragging both splitters changed too few pixels (%s).\n' "$drag_pixels" >&2
  exit 1
fi
restore_pixels="$(pixel_diff_count "$artifact_dir/after.png" "$artifact_dir/restored.png")"
if (( restore_pixels > 50000 )); then
  printf 'The saved splitter layout changed after relaunch (%s pixels differ).\n' "$restore_pixels" >&2
  exit 1
fi
printf 'Both rails dragged visibly (%s pixels changed) and the per-project layout restored after relaunch (%s pixels differed).\n' "$drag_pixels" "$restore_pixels"
BASH
