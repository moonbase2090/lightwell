#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-source-inspector.sh <app-binary> <artifact-directory>}"
artifact_dir="${2:?Usage: capture-source-inspector.sh <app-binary> <artifact-directory>}"

if [[ ! -x "$app_path" ]]; then
  printf 'Lightwell app binary is missing or not executable: %s\n' "$app_path" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
workspace="$(mktemp -d)"
config_home="$(mktemp -d)"
editor_log="$(mktemp)"
app_log="$(mktemp)"
editor_command="$workspace/record-editor.sh"
trap 'rm -rf "$workspace" "$config_home"; rm -f "$editor_log" "$app_log"' EXIT

mkdir -p "$workspace/src" "$config_home/com.moonbase2090.lightwell"
cat >"$workspace/Cargo.toml" <<'EOF'
[package]
name = "inspector-proof"
version = "0.1.0"
edition = "2021"
EOF
for line in $(seq 1 42); do
  printf '// Context line %s\n' "$line"
done >"$workspace/src/lib.rs"
printf 'pub mod inspector_target {\n    pub fn selected() -> u8 { 42 }\n}\n' >>"$workspace/src/lib.rs"
cat >"$editor_command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s\n' "$1" "$2" "$3" >"$EDITOR_LOG_PATH"
EOF
chmod +x "$editor_command"
node - "$workspace" "$config_home/com.moonbase2090.lightwell/recent-workspaces.json" "$config_home/com.moonbase2090.lightwell/editor-settings.json" "$editor_command" <<'NODE'
const fs = require("node:fs");
const [workspace, recentPath, settingsPath, editorCommand] = process.argv.slice(2);
fs.writeFileSync(recentPath, JSON.stringify([{ id: workspace, label: "Inspector proof" }]));
fs.writeFileSync(settingsPath, JSON.stringify({
  commandTemplate: `${editorCommand} {file} {line} {column}`,
}));
NODE

XDG_CONFIG_HOME="$config_home" EDITOR_LOG_PATH="$editor_log" xvfb-run -a --server-args='-screen 0 1440x900x24' \
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
    xdotool key ctrl+k
    xdotool type --clearmodifiers --delay 45 inspector_target
    sleep 2
    xdotool key Return
    sleep 8
    import -window "$window_id" "$artifact_dir/source-inspector.png"

    xdotool mousemove --window "$window_id" 1110 285 click 1
    for _ in $(seq 1 15); do
      if [[ -s "$EDITOR_LOG_PATH" ]]; then break; fi
      sleep 1
    done
    if [[ ! -s "$EDITOR_LOG_PATH" ]]; then
      cat "$app_log" >&2
      printf "Open in editor did not invoke the configured command.\n" >&2
      exit 1
    fi
    expected_suffix="/src/lib.rs|43|9"
    if [[ "$(cat "$EDITOR_LOG_PATH")" != *"$expected_suffix" ]]; then
      printf "Unexpected editor target: %s\n" "$(cat "$EDITOR_LOG_PATH")" >&2
      exit 1
    fi

    xdotool mousemove --window "$window_id" 1080 32 click 1
    sleep 2
    import -window "$window_id" "$artifact_dir/editor-settings.png"
    settings_changed_pixels="$(compare -metric AE "$artifact_dir/source-inspector.png" "$artifact_dir/editor-settings.png" null: 2>&1 || true)"
    if [[ "$settings_changed_pixels" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
      printf -v settings_changed_pixel_count "%.0f" "$settings_changed_pixels"
    else
      settings_changed_pixel_count=0
    fi
    if (( settings_changed_pixel_count < 10000 )); then
      printf "The editor settings panel did not visibly open (%s changed pixels).\n" "$settings_changed_pixels" >&2
      exit 1
    fi
    read -r width height < <(identify -format "%w %h\n" "$artifact_dir/source-inspector.png")
    if (( width < 800 || height < 500 )); then
      printf "Screenshot is too small: %sx%s\n" "$width" "$height" >&2
      exit 1
    fi
    printf "The built app inspected src/lib.rs at line 43, column 9 and launched the configured editor command.\n"
  ' lightwell-source-inspector "$app_path" "$artifact_dir" "$app_log"
