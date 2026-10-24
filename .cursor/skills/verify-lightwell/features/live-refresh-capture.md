# Live map refresh capture

The built Linux desktop app displays a newly added Rust module without reopening the workspace.

## Preconditions

- Build the Tauri app for Linux.
- Install Node.js, Xvfb, xdotool, ImageMagick and `tesseract-ocr`.
- Run from the repository root. The helper creates its own display and isolated application data and configuration.

## Drive

```sh
scripts/ci/capture-live-refresh.sh <app-binary> /tmp/lightwell-verify-$RUN_ID/proof/live-refresh
```

The helper uses a 1280 by 850 window with the default pane layout. It waits for the fixture map to render, searches for `before` to bring the Rust modules into scope, and waits for that module in the map pane. It then adds `after.rs` and its module declaration and waits for `after` in the same pane.

Text recognition excludes search results, summary counts and the source inspector. A changed counter or a repaint cannot satisfy the module-label assertion. Each phase has a bounded wait. Exit `0` requires both literal module labels and a screenshot of at least 800 by 500 pixels.

## Evidence

Retain `before.png`, `after.png`, their recognized text files, and `app.log`. Success prints `The built app showed module before, then module after following a Rust source edit.` CI uploads diagnostics on failure as well as success.

A negative control that leaves the fixture source unchanged must time out waiting for `after`. This checks that a repaint alone cannot pass the capture.
