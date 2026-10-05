#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-live-refresh.sh <app-binary> <artifact-directory>}"
artifact_dir="${2:?Usage: capture-live-refresh.sh <app-binary> <artifact-directory>}"

if [[ ! -x "$app_path" ]]; then
  printf 'Lightwell app binary is missing or not executable: %s\n' "$app_path" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
workspace="$(mktemp -d)"
config_home="$(mktemp -d)"
app_log="$(mktemp)"
trap 'rm -rf "$workspace" "$config_home"; rm -f "$app_log"' EXIT

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

XDG_CONFIG_HOME="$config_home" xvfb-run -a --server-args='-screen 0 1440x900x24' \
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

    sleep 5
    import -window "$window_id" "$artifact_dir/before.png"
    printf "pub mod before;\\npub mod after;\\n" >"$workspace/src/lib.rs"
    printf "pub fn value() -> u8 { 2 }\\n" >"$workspace/src/after.rs"

    changed_pixels=0
    for _ in $(seq 1 30); do
      sleep 1
      import -window "$window_id" "$artifact_dir/after.png"
      changed_pixels="$(compare -metric AE "$artifact_dir/before.png" "$artifact_dir/after.png" null: 2>&1 || true)"
      if [[ "$changed_pixels" =~ ^[0-9]+$ ]] && (( changed_pixels > 100 )); then
        break
      fi
    done

    if ! [[ "$changed_pixels" =~ ^[0-9]+$ ]] || (( changed_pixels <= 100 )); then
      cat "$app_log" >&2
      printf "The live map did not visibly change after the Rust source edit.\n" >&2
      exit 1
    fi

    read -r width height < <(identify -format "%w %h\\n" "$artifact_dir/after.png")
    if (( width < 800 || height < 500 )); then
      printf "Screenshot is too small: %sx%s\\n" "$width" "$height" >&2
      exit 1
    fi
    printf "The built app refreshed its map after a Rust source edit (%s changed pixels).\\n" "$changed_pixels"
  ' lightwell-live-refresh "$app_path" "$artifact_dir" "$workspace" "$app_log"
