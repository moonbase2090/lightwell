#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: capture-project-notes.sh <app-binary> <artifact-directory>}"
artifact_dir="${2:?Usage: capture-project-notes.sh <app-binary> <artifact-directory>}"

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
name = "notes-proof"
version = "0.1.0"
edition = "2021"
EOF
printf 'pub mod sample;\n' >"$workspace/src/lib.rs"
printf 'pub fn value() -> u8 { 1 }\n' >"$workspace/src/sample.rs"
node - "$workspace" "$config_home/com.moonbase2090.lightwell/recent-workspaces.json" <<'NODE'
const fs = require("node:fs");
const [workspace, configPath] = process.argv.slice(2);
fs.writeFileSync(configPath, JSON.stringify([{ id: workspace, label: "Notes proof" }]));
NODE

XDG_CONFIG_HOME="$config_home" xvfb-run -a --server-args='-screen 0 1440x900x24' \
  bash -e -u -o pipefail -s -- "$app_path" "$artifact_dir" "$workspace" "$app_log" <<'BASH'
    app_path="$1"
    artifact_dir="$2"
    workspace="$3"
    app_log="$4"
    block_id="module:notes-proof:crate root::sample"
    notes_file="$workspace/.lightwell/notes.json"

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

    eval "$(xdotool getwindowgeometry --shell "$window_id")"
    source_panel_width=318
    topbar_height=54
    overview_height=54
    inspector_close_x=$((WIDTH - 36))
    inspector_close_y=$((topbar_height + overview_height + 24))
    details_panel_x=$((WIDTH - source_panel_width / 2))
    details_add_note_y=$((topbar_height + overview_height + 142))
    dialog_left=$(( (WIDTH - 860) / 2 ))
    dialog_top=$(( (HEIGHT - 640) / 2 ))
    note_textarea_x=$((dialog_left + 612))
    note_textarea_y=$((dialog_top + 372))
    note_save_x=$((dialog_left + 812))
    note_save_y=$((dialog_top + 598))
    note_remove_x=$((dialog_left + 700))
    note_remove_y=$note_save_y

    type_in_note_textarea() {
      local text="$1"
      xdotool mousemove --window "$window_id" "$note_textarea_x" "$note_textarea_y" click --repeat 2 1
      sleep 2
      xdotool key --clearmodifiers ctrl+a BackSpace
      sleep 1
      xdotool type --clearmodifiers --delay 100 "$text"
      sleep $(( ${#text} * 100 / 1000 + 4 ))
      # Let React flush textarea onChange before Save reads editor.text (CI saw "ote one." otherwise).
      xdotool key --clearmodifiers End space BackSpace
      sleep 3
    }

    save_note_in_dialog() {
      xdotool mousemove --window "$window_id" "$note_save_x" "$note_save_y" click 1
      sleep 2
    }

    open_project_notes_dialog() {
      xdotool mousemove --window "$window_id" "$inspector_close_x" "$inspector_close_y" click 1
      sleep 2
      xdotool mousemove --window "$window_id" "$details_panel_x" "$details_add_note_y" click 1
      sleep 1
      xdotool mousemove --window "$window_id" "$details_panel_x" "$details_add_note_y" click 1
      sleep 1
      xdotool key --clearmodifiers n
      sleep 4
    }

    sleep 12
    # Bare Xvfb has no window manager. A click focuses the window; windowactivate --sync does not.
    xdotool mousemove --window "$window_id" 180 80 click 1
    sleep 1
    xdotool key --clearmodifiers ctrl+k
    xdotool type --clearmodifiers --delay 45 sample
    sleep 2
    xdotool key --clearmodifiers Return
    sleep 10
    open_project_notes_dialog
    type_in_note_textarea "Architecture note one."
    save_note_in_dialog
    for _ in $(seq 1 15); do
      if [[ -s "$notes_file" ]]; then break; fi
      sleep 1
    done
    if [[ ! -s "$notes_file" ]]; then
      import -window "$window_id" "$artifact_dir/notes-failure.png" 2>/dev/null || true
      printf "Window geometry was %sx%s (notes dialog origin %s,%s).\n" "$WIDTH" "$HEIGHT" "$dialog_left" "$dialog_top" >&2
      ls -la "$workspace/.lightwell" >&2 2>&1 || true
      cat "$app_log" >&2
      printf "Saving the first project note did not create .lightwell/notes.json.\n" >&2
      exit 1
    fi
    node - "$notes_file" "$block_id" "Architecture note one." <<'NODE'
const fs = require("node:fs");
const [path, blockId, expectedText] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(path, "utf8"));
if (document.schemaVersion !== 1 || document.notes?.[blockId]?.text !== expectedText) {
  process.stderr.write(`Unexpected notes document: ${JSON.stringify(document)}\n`);
  throw new Error("The first saved project note did not match the workspace file.");
}
NODE

    type_in_note_textarea "Architecture note updated."
    save_note_in_dialog
    sleep 2
    node - "$notes_file" "$block_id" "Architecture note updated." <<'NODE'
const fs = require("node:fs");
const [path, blockId, expectedText] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(path, "utf8"));
if (document.notes?.[blockId]?.text !== expectedText) {
  throw new Error("Editing the project note did not update its saved text.");
}
NODE
    node - "$notes_file" "$block_id" >"$artifact_dir/note-fingerprint.txt" <<'NODE'
const fs = require("node:fs");
const [path, blockId] = process.argv.slice(2);
process.stdout.write(JSON.parse(fs.readFileSync(path, "utf8")).notes[blockId].sourceFingerprint);
NODE
    import -window "$window_id" "$artifact_dir/notes-current.png"
    read -r window_width window_height < <(identify -format "%w %h\n" "$artifact_dir/notes-current.png")
    dialog_left=$(( (window_width - 860) / 2 ))
    dialog_top=$(( (window_height - 640) / 2 ))
    convert "$artifact_dir/notes-current.png" -crop "860x640+$dialog_left+$dialog_top" +repage "$artifact_dir/.notes-dialog-current.png"

    printf 'pub fn value() -> u8 { 2 }\npub fn revised() -> bool { true }\n' >"$workspace/src/sample.rs"
    changed_pixels=0
    for _ in $(seq 1 35); do
      sleep 1
      import -window "$window_id" "$artifact_dir/notes-stale.png"
      convert "$artifact_dir/notes-stale.png" -crop "860x640+$dialog_left+$dialog_top" +repage "$artifact_dir/.notes-dialog-stale.png"
      pixel_metric="$(compare -metric AE "$artifact_dir/.notes-dialog-current.png" "$artifact_dir/.notes-dialog-stale.png" null: 2>&1 || true)"
      if [[ "$pixel_metric" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
        printf -v changed_pixels "%.0f" "$pixel_metric"
      fi
      if (( changed_pixels > 100 )); then break; fi
    done
    if (( changed_pixels <= 100 )); then
      cat "$app_log" >&2
      printf "The app did not visibly mark the edited source note stale.\n" >&2
      exit 1
    fi
    node - "$notes_file" "$block_id" "Architecture note updated." "$artifact_dir/note-fingerprint.txt" <<'NODE'
const fs = require("node:fs");
const [path, blockId, expectedText, fingerprintPath] = process.argv.slice(2);
const note = JSON.parse(fs.readFileSync(path, "utf8")).notes?.[blockId];
const originalFingerprint = fs.readFileSync(fingerprintPath, "utf8");
if (note?.text !== expectedText || note.sourceFingerprint !== originalFingerprint) {
  throw new Error("The stale project note was removed or rewritten during the source refresh.");
}
NODE

    xdotool mousemove --window "$window_id" "$note_remove_x" "$note_remove_y" click 1
    for _ in $(seq 1 15); do
      if node - "$notes_file" "$block_id" <<'NODE'
const fs = require("node:fs");
const [path, blockId] = process.argv.slice(2);
try {
  const document = JSON.parse(fs.readFileSync(path, "utf8"));
  process.exit(Object.hasOwn(document.notes ?? {}, blockId) ? 1 : 0);
} catch {
  process.exit(1);
}
NODE
      then break; fi
      sleep 1
    done
    node - "$notes_file" "$block_id" <<'NODE'
const fs = require("node:fs");
const [path, blockId] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(path, "utf8"));
if (Object.hasOwn(document.notes ?? {}, blockId)) {
  throw new Error("Removing the project note left it in .lightwell/notes.json.");
}
NODE
    removed_pixels=0
    for _ in $(seq 1 15); do
      import -window "$window_id" "$artifact_dir/notes-removed.png"
      convert "$artifact_dir/notes-removed.png" -crop "860x640+$dialog_left+$dialog_top" +repage "$artifact_dir/.notes-dialog-removed.png"
      pixel_metric="$(compare -metric AE "$artifact_dir/.notes-dialog-stale.png" "$artifact_dir/.notes-dialog-removed.png" null: 2>&1 || true)"
      if [[ "$pixel_metric" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
        printf -v removed_pixels "%.0f" "$pixel_metric"
      fi
      if (( removed_pixels > 100 )); then break; fi
      sleep 1
    done
    if (( removed_pixels <= 100 )); then
      cat "$app_log" >&2
      printf "The notes dialog did not visibly update after the saved note was removed.\n" >&2
      exit 1
    fi
    read -r width height < <(identify -format "%w %h\n" "$artifact_dir/notes-current.png")
    if (( width < 800 || height < 500 )); then
      printf "Screenshot is too small: %sx%s\n" "$width" "$height" >&2
      exit 1
    fi
    printf "The built app created, edited, retained as stale, and removed a project note (%s pixels changed after the source edit; %s after removal).\n" "$changed_pixels" "$removed_pixels"
BASH
