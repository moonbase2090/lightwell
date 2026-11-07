#!/usr/bin/env bash
set -euo pipefail

app_path="$(realpath "${1:?Usage: capture-atlas-detail.sh <app-binary> <workspace> <artifact-directory> [before]}")"
workspace="$(realpath "${2:?Workspace required}")"
mkdir -p "${3:?Artifact directory required}"
artifact_dir="$(realpath "$3")"
phase="${4:-after}"
profile="$(mktemp -d)"
app_log="$artifact_dir/app.log"
trap 'rm -rf "$profile"' EXIT
# CLI and desktop builds share the same output filename. Keep the running
# desktop executable separate from later doctor/CLI builds.
cp "$app_path" "$profile/lightwell-desktop"
app_path="$profile/lightwell-desktop"
mkdir -p "$profile/config/com.moonbase2090.lightwell" "$profile/data" "$profile/cache"
node - "$workspace" "$profile/config/com.moonbase2090.lightwell/recent-workspaces.json" <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.argv[3], JSON.stringify([{ id: process.argv[2], label: "Prismattyc" }]));
NODE

OMP_THREAD_LIMIT=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache" \
  xvfb-run -a --server-args='-screen 0 1440x900x24' bash -e -u -o pipefail -c '
    app_path="$1"
    artifact_dir="$2"
    app_log="$3"
    phase="$4"
    "$app_path" >"$app_log" 2>&1 &
    app_pid=$!
    trap '\''kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true'\'' EXIT
    window_id=""
    for _ in $(seq 1 90); do
      window_id="$(xdotool search --onlyvisible --name Lightwell 2>/dev/null | head -1 || true)"
      if [[ -n "$window_id" ]]; then break; fi
      if ! kill -0 "$app_pid" 2>/dev/null; then cat "$app_log" >&2; exit 1; fi
      sleep 1
    done
    [[ -n "$window_id" ]] || { cat "$app_log" >&2; exit 1; }
    xdotool windowsize "$window_id" 1440 900
    wait_for_text() {
      local name="$1" pattern="$2"
      for _ in $(seq 1 90); do
        import -window "$window_id" "$artifact_dir/$name.png"
        convert "$artifact_dir/$name.png" -crop 1440x160+0+0 +repage -resize 200% -colorspace Gray "$artifact_dir/header-ocr.png"
        if [[ "$name" == atlas-fit ]]; then
          tesseract "$artifact_dir/header-ocr.png" stdout --psm 6 2>/dev/null >"$artifact_dir/$name.txt"
        else
          convert "$artifact_dir/$name.png" -crop 320x792+1120+108 +repage -resize 200% -colorspace Gray "$artifact_dir/source-ocr.png"
          tesseract "$artifact_dir/source-ocr.png" stdout --psm 6 2>/dev/null >"$artifact_dir/$name.txt"
        fi
        if grep -Eiq "$pattern" "$artifact_dir/$name.txt"; then return 0; fi
        if ! kill -0 "$app_pid" 2>/dev/null; then break; fi
        sleep 1
      done
      cat "$app_log" >&2
      printf "Atlas desktop proof did not show %s.\n" "$pattern" >&2
      return 1
    }
    wait_for_text atlas-fit "ready"
    if [[ "$phase" == before ]]; then
      printf "Atlas baseline fit screenshot captured.\n"
      exit 0
    fi
    xdotool mousemove --window "$window_id" 740 500 click --repeat 12 --delay 120 4
    sleep 2
    import -window "$window_id" "$artifact_dir/atlas-zoom.png"
    tesseract "$artifact_dir/atlas-zoom.png" stdout 2>/dev/null >"$artifact_dir/atlas-zoom.txt"
    # The outline filter stays fixed while only the map zooms. End focuses
    # the final matching file/symbol row; Enter selects it without Open source.
    xdotool mousemove --window "$window_id" 140 286 click 1
    xdotool key ctrl+a
    xdotool type --clearmodifiers --delay 40 cell_grid
    sleep 2
    xdotool key Tab Tab End Return
    wait_for_text atlas-source "READ.?ONLY[[:space:]]+SOURCE"
    grep -Eiq "cell.?grid.rs" "$artifact_dir/atlas-source.txt"
    grep -Eq "Vec<|pub\(super\)" "$artifact_dir/atlas-source.txt"
    printf "Atlas desktop proof captured fit, zoom and automatic source opening.\n"
  ' lightwell-atlas-proof "$app_path" "$artifact_dir" "$app_log" "$phase"
