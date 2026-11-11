# Lightwell verification map

Read this index before driving Lightwell. Each feature file is a user-facing recipe with exact commands and observable proof.

## Baseline preconditions

- Repository root is the Lightwell clone under test.
- `scripts/verify/doctor.sh` exits `0`.
- Set `RUN_ID` for the run; use `/tmp/lightwell-verify-$RUN_ID/` for scratch and proof paths.

## Driving conventions

- Build the CLI once per run (`cargo build -p lightwell-cli --locked`).
- Start at most one preview server per run; record its PID.
- Prefer feature-map commands over ad-hoc shortcuts.

## Proof and skip reporting

- Capture commands, exit codes, and output paths under `/tmp/lightwell-verify-$RUN_ID/proof/`.
- Report unreachable features with the missing prerequisite (for example Tauri prerequisites not installed).

## Features

- [Project symbol definitions](./symbol-definitions.md) verifies F12 and Ctrl/Cmd-click navigation, ambiguity, index refresh and real desktop source positions.
- [Files in a block](./block-source-files.md) verifies mapped file selection, editor and note targets, selection reset and delayed source responses.

- [Modules breadcrumb return](./breadcrumb-layout.md) verifies completed-layout reuse and repeated before/after timings, including timeout fallback and graph correctness.

- [CLI workspace extract](./cli-extract.md) — produce a schema v1 facts JSON from this repository.
- [macOS command on PATH](./macos-cli-path.md) — a fresh shell resolves the bundled `lightwell` command (macOS only).
- [Browser preview maps](./browser-preview-maps.md) — serve the built viewer and confirm the preview responds.
- [Map search](./map-search.md) — keyboard search over the architecture map (manual or browser automation).
- [Project notes capture](./project-notes-capture.md) — desktop create, edit, stale, and remove on Linux with Xvfb (skip when Tauri display tools are missing).
- [Live map refresh capture](./live-refresh-capture.md) — add a Rust module and verify its visible label in the built Linux app, with bounded waits and failure diagnostics.

- [Concurrent commit maps](./commit-map-concurrency.md) verifies repository ownership and temporary-worktree cleanup through concurrent public API calls.

- [Commit range toolbar](./commit-range-presets.md) verifies Show changes presets, exact Git counts, chronological custom endpoints, keyboard navigation and native screenshot approval.

- [Atlas label detail and source selection](./atlas-detail.md) verifies group-only fit labels, zoom-dependent readable labels, monospace text, and automatic source opening in the desktop app.
