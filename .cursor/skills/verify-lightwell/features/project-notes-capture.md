# Project notes capture

A developer adds, edits, and removes a project note on a block in the desktop app. Linux CI drives that path on the built binary.

## Sub-features

- `notes-create` — Save writes `.lightwell/notes.json` for the selected module.
- `notes-edit` — a second save replaces the note text.
- `notes-stale` — editing the module source marks the open note stale without rewriting it.
- `notes-remove` — Remove deletes that note from the file and updates the dialog.

## How to get to it (user POV)

- Open a Cargo workspace in the Tauri app.
- Select a module, open **Notes**, write the note, and choose **Save note**.
- Edit the text and choose **Save changes**.
- Change the module source; the open note shows **Source changed** and stays in the file.
- Choose **Remove**.

## Driving it on Linux

Preconditions:

- A built Lightwell app binary (CI uses `target/x86_64-unknown-linux-gnu/release/lightwell` from `npm run tauri:build`).
- `node`, `xvfb-run`, `xdotool`, and ImageMagick (`import`, `convert`, `compare`, `identify`).
- Skip this feature when any of those are missing, and report the missing prerequisite. Browser preview and `lightwell extract` do not exercise this dialog.

The script starts its own display. Do not wrap it in another `xvfb-run`, and do not call `xdotool windowactivate --sync` (bare Xvfb has no `_NET_ACTIVE_WINDOW`).

```sh
scripts/ci/capture-project-notes.sh <app-binary> /tmp/lightwell-verify-$RUN_ID/proof/project-notes
```

Expect exit `0` and stdout containing `The built app created, edited, retained as stale, and removed a project note`.

The script builds a temporary `notes-proof` crate (`src/sample.rs`), points recent workspaces at it, and then:

1. Click the overview title (y=80) so the undecorated window has keyboard focus. Do not use `windowactivate`.
2. Ctrl+K, type `sample`, Return, wait for the source inspector to load (~8s). Tab once so focus leaves the search field. The module label is `sample`.
3. Click the map canvas, press `N` to open project notes for the selected block.
4. Click the note textarea, type `Architecture note one.`, click **Save note** (dialog origin + 812, +598). The file must be schema version 1 and the text for `module:notes-proof:crate root::sample` must match.
5. Click the textarea, replace the text with `Architecture note updated.`, click **Save changes**.
6. Rewrite `src/sample.rs`. The dialog crop must change by more than 100 pixels. The saved text and `sourceFingerprint` must stay the same.
7. Click **Remove**. That block id must be gone, and the dialog crop must change by more than 100 pixels from the stale shot.

## Layout assumptions

Coordinates are derived from `xdotool getwindowgeometry --shell` for the live window. They match the default desktop layout and break if that layout changes:

- Window defaults are 1280×850 (`crates/lightwell-app/tauri.conf.json`). Xvfb is `-screen 0 1440x900x24`. There is no window-manager frame, so geometry origin is the client area.
- Top bar and overview row are each 54px (`src/style.css`). **Notes** is in the map toolbar at `y = 54 + 54 + 24` and `x = map panel width - 56`.
- The map/source split uses a 318px source panel (`defaultTrailingSize` in `src/App.tsx`) and a 6px gutter in the script.
- The notes dialog is 860×640 and centered (`.project-notes-dialog`). Textarea click is dialog origin + (612, 372). Save is + (812, 598). Remove is + (700, 598), the button before Save.

## Evidence

Under the artifact directory:

- `notes-current.png`, `notes-stale.png`, and `notes-removed.png` (each at least 800×500).
- The stdout line with the stale and removal pixel counts.

CI runs this inside `tauri-linux-artifact` and uploads `lightwell-project-notes-linux-screenshots`.

## Gotchas

- Ctrl+K focuses the search input. Opening the source inspector focuses Monaco; click the map before toolbar/dialog clicks. Escape only clears the query (`setSearch("")` in `handleSearchKey`).
- In `ProjectNotesDialog`, tab order with a saved note is Close, New, the note row, the textarea, Remove, Save. One Tab from Save wraps to Close. The capture clicks Remove instead of tabbing.
- Screenshot crops assume the 860×640 dialog. A different dialog size invalidates both the clicks and the stale/removal pixel compare.
