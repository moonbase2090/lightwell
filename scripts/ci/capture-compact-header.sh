#!/usr/bin/env bash
set -euo pipefail

before_app="${1:?Usage: capture-compact-header.sh <before-app> <after-app> <artifact-directory>}"
after_app="${2:?Usage: capture-compact-header.sh <before-app> <after-app> <artifact-directory>}"
artifact_dir="${3:?Usage: capture-compact-header.sh <before-app> <after-app> <artifact-directory>}"

for app_path in "$before_app" "$after_app"; do
  if [[ ! -x "$app_path" ]]; then
    printf 'Lightwell app binary is missing or not executable: %s\n' "$app_path" >&2
    exit 1
  fi
done

mkdir -p "$artifact_dir"
workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

mkdir -p "$workspace/src"
cat >"$workspace/Cargo.toml" <<'EOF'
[package]
name = "compact-header-proof"
version = "0.1.0"
edition = "2021"
EOF
cat >"$workspace/src/lib.rs" <<'EOF'
pub mod compact_header_proof {
    pub fn screen() -> &'static str {
        "1440x900"
    }
}
EOF

capture() {
  local app_path="$1"
  local name="$2"
  local config_home data_home app_log
  config_home="$(mktemp -d)"
  data_home="$(mktemp -d)"
  app_log="$(mktemp)"
  mkdir -p "$config_home/com.moonbase2090.lightwell"
  node - "$workspace" "$config_home/com.moonbase2090.lightwell/recent-workspaces.json" <<'NODE'
const fs = require("node:fs");
const [workspace, recentPath] = process.argv.slice(2);
fs.writeFileSync(recentPath, JSON.stringify([{ id: workspace, label: "Compact header proof" }]));
NODE

  XDG_CONFIG_HOME="$config_home" XDG_DATA_HOME="$data_home" xvfb-run -a --server-args='-screen 0 1600x1000x24' \
    bash -e -u -o pipefail -c '
      app_path="$1"
      screenshot_path="$2"
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

      xdotool windowsize --sync "$window_id" 1440 900
      xdotool windowmove "$window_id" 0 0
      sleep 8
      import -window "$window_id" "$screenshot_path"
      dimensions="$(identify -format "%wx%h" "$screenshot_path")"
      if [[ "$dimensions" != "1440x900" ]]; then
        printf "Expected a 1440x900 app screenshot, found %s (%s).\n" "$dimensions" "$screenshot_path" >&2
        exit 1
      fi
    ' lightwell-compact-header "$app_path" "$artifact_dir/$name.png" "$app_log"

  rm -rf "$config_home" "$data_home"
  rm -f "$app_log"
}

capture "$before_app" before
capture "$after_app" after

changed_pixels="$(compare -metric AE "$artifact_dir/before.png" "$artifact_dir/after.png" null: 2>&1 || true)"
changed_pixels="${changed_pixels%% *}"
if [[ ! "$changed_pixels" =~ ^[0-9]+$ ]] || (( changed_pixels < 50000 )); then
  printf 'The compact-header screenshots differ by too few pixels (%s).\n' "$changed_pixels" >&2
  exit 1
fi

printf 'Captured before and after app windows at 1440x900 (%s pixels changed).\n' "$changed_pixels"
