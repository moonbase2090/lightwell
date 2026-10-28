#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-theme-picker.sh <app-binary> <artifact-directory> [capture-splitters]}"
artifact_dir="${2:?Usage: capture-theme-picker.sh <app-binary> <artifact-directory> [capture-splitters]}"
capture_splitters="${3:-false}"

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
    capture_splitters="$4"

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
    window_width="$(xdotool getwindowgeometry "$window_id" | sed -n "s/.*Geometry: \\([0-9][0-9]*\\)x.*/\\1/p")"
    window_height="$(xdotool getwindowgeometry "$window_id" | sed -n "s/.*Geometry: [0-9][0-9]*x\\([0-9][0-9]*\\).*/\\1/p")"
    if [[ ! "$window_width" =~ ^[0-9]+$ ]]; then
      printf "Could not read the Lightwell window width.\n" >&2
      exit 1
    fi
    if [[ ! "$window_height" =~ ^[0-9]+$ ]]; then
      printf "Could not read the Lightwell window height.\n" >&2
      exit 1
    fi
    # Settings is the rightmost top-bar control: a 25px margin, then an 87px button.
    # Its centre is about 68px from the right edge.
    settings_button_x=$((window_width - 68))
    # Match .editor-settings-panel sizing in src/style.css (min(760px, 90vw), min(85vh, 100vh - 48px)).
    panel_width=$((window_width * 90 / 100))
    if (( panel_width > 760 )); then panel_width=760; fi
    panel_height=$((window_height * 85 / 100))
    if (( panel_height > window_height - 48 )); then panel_height=$((window_height - 48)); fi
    theme_select_x=$((window_width / 2))
    theme_select_y=$((window_height / 2 - panel_height / 2 + 155))
    settings_close_x=$((window_width / 2 + panel_width / 2 - 32))
    settings_close_y=$((window_height / 2 - panel_height / 2 + 40))
    if [[ "$capture_splitters" == "true" ]]; then
      main_top=108
      main_height=$((window_height - main_top - 28))
      splitter_x=$((window_width - 318 - 4))
      splitter_outer_y=$((main_top + main_height / 2))
      splitter_inner_x=$((splitter_x / 2))
      splitter_inner_y=$((main_top + 47 + main_height - 47 - 8 - 197 + 4))
    fi

    capture_theme() {
      theme_name="$1"
      down_count="$2"
      xdotool mousemove --window "$window_id" "$settings_button_x" 32 click 1
      sleep 1
      xdotool mousemove --window "$window_id" "$theme_select_x" "$theme_select_y" click 1
      xdotool key Home
      for _ in $(seq 1 "$down_count"); do xdotool key Down; done
      xdotool key Return
      sleep 2
      import -window "$window_id" "$artifact_dir/theme-settings-$theme_name.png"
      xdotool mousemove --window "$window_id" "$settings_close_x" "$settings_close_y" click 1
      sleep 2
      xdotool mousemove --window "$window_id" 2 2
      import -window "$window_id" "$artifact_dir/theme-$theme_name.png"
      if [[ "$capture_splitters" == "true" ]]; then
        xdotool mousemove --window "$window_id" "$splitter_x" "$splitter_outer_y"
        sleep 0.3
        import -window "$window_id" "$artifact_dir/rail-$theme_name-map-source.png"
        xdotool mousemove --window "$window_id" "$splitter_inner_x" "$splitter_inner_y"
        sleep 0.3
        import -window "$window_id" "$artifact_dir/rail-$theme_name-feature-groups.png"
      fi
    }

    capture_theme system 0
    capture_theme dark 1
    capture_theme light 2
    capture_theme blueprint 3

    pixel_diff_count() {
      local raw_count rounded_count
      raw_count="$(compare -metric AE "$1" "$2" null: 2>&1 || true)"
      # ImageMagick 7 appends " (normalized)" to the AE count; keep the count.
      raw_count="${raw_count%% *}"
      if [[ "$raw_count" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
        printf -v rounded_count "%.0f" "$raw_count"
        printf "%s" "$rounded_count"
      else
        printf "0"
      fi
    }

    for image in system dark light blueprint; do
      read -r width height < <(identify -format "%w %h\n" "$artifact_dir/theme-$image.png")
      if (( width < 800 || height < 500 )); then
        printf "Theme screenshot is too small: %sx%s\n" "$width" "$height" >&2
        exit 1
      fi
      visible_map_colors="$(identify -format "%k" -crop 300x120+320+270 "$artifact_dir/theme-$image.png")"
      if [[ ! "$visible_map_colors" =~ ^[0-9]+$ ]] || (( visible_map_colors < 10 )); then
        printf "The %s screenshot is missing its visible map block (%s colors in the block area).\n" "$image" "$visible_map_colors" >&2
        exit 1
      fi
      if [[ "$image" == "blueprint" ]]; then
        blueprint_node_pixels="$(convert "$artifact_dir/theme-blueprint.png" -crop 300x120+320+270 -colorspace gray -threshold 90% -format "%[fx:mean*w*h]" info:)"
        if ! awk -v pixels="$blueprint_node_pixels" "BEGIN { exit !(pixels >= 250) }"; then
          printf "The Blueprint screenshot is missing its white block outline (%s bright pixels in the block area).\n" "$blueprint_node_pixels" >&2
          exit 1
        fi
      fi
      changed_pixels="$(pixel_diff_count "$artifact_dir/theme-settings-$image.png" "$artifact_dir/theme-$image.png")"
      if (( changed_pixels < 20000 )); then
        printf "The %s Settings panel did not close before its theme screenshot.\n" "$image" >&2
        exit 1
      fi
      if [[ "$capture_splitters" == "true" ]]; then
        for splitter in map-source feature-groups; do
          changed_pixels="$(pixel_diff_count "$artifact_dir/theme-$image.png" "$artifact_dir/rail-$image-$splitter.png")"
          if (( changed_pixels < 20 )); then
            printf "Hovering the %s rail was not visible in the %s theme screenshot.\n" "$splitter" "$image" >&2
            exit 1
          fi
        done
      fi
    done
    for pair in "dark light" "light blueprint"; do
      read -r left right <<<"$pair"
      changed_pixels="$(pixel_diff_count "$artifact_dir/theme-$left.png" "$artifact_dir/theme-$right.png")"
      if (( changed_pixels < 20000 )); then
        printf "Themes %s and %s were not visibly different (%s changed pixels).\n" "$left" "$right" "$changed_pixels" >&2
        exit 1
      fi
    done
    printf "The built app applied Follow system, Dark, Light, and Blueprint from Settings.\n"
  ' lightwell-theme-picker "$app_path" "$artifact_dir" "$app_log" "$capture_splitters"
