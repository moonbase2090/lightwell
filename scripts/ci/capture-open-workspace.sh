#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-open-workspace.sh <app-binary> <screenshot-path>}"
screenshot_path="${2:?Usage: capture-open-workspace.sh <app-binary> <screenshot-path>}"

if [[ ! -x "$app_path" ]]; then
  printf 'Lightwell app binary is missing or not executable: %s\n' "$app_path" >&2
  exit 1
fi

mkdir -p "$(dirname "$screenshot_path")"
config_home="$(mktemp -d)"
app_log="$(mktemp)"
trap 'rm -rf "$config_home"; rm -f "$app_log"' EXIT

XDG_CONFIG_HOME="$config_home" xvfb-run -a --server-args='-screen 0 1440x900x24' \
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

    sleep 3
    import -window "$window_id" "$screenshot_path"
    read -r width height < <(identify -format "%w %h\n" "$screenshot_path")
    if (( width < 800 || height < 500 )); then
      printf "Screenshot is too small: %sx%s\n" "$width" "$height" >&2
      exit 1
    fi
    printf "Captured the Lightwell empty-workspace screen at %sx%s.\n" "$width" "$height"
  ' lightwell-screenshot "$app_path" "$screenshot_path" "$app_log"
