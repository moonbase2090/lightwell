# Navigate among files in a block

Open a block with multiple mapped source files. Its source inspector shows **Source file**. Choose a path to inspect that file, then choose the primary path to return. The list includes the opened block and its mapped descendants, with one entry per path. Dependencies and files absent from the map are excluded.

The selector keeps the original block's file list while the source title, editor action and project-note action follow the displayed file's mapped block. Opening another block normally starts a new list. Commit diffs keep their existing single-file view.

## Browser checks

Run the doctor, then the focused checks or full suite:

```sh
scripts/verify/doctor.sh
node_modules/.bin/playwright test e2e/source-files.spec.ts
npm run test:e2e
```

The checks run at desktop and narrow widths. They cover switching and returning, duplicate path removal, unrelated sibling exclusion, notes and editor targets, closing/reopening, definition-jump integration, normal selection reset, and ignoring a slow source response after another choice.

## Native Linux desktop proof

Use a clean VM with the Tauri Linux build dependencies, Node.js 22, Rust, Git, Xvfb, xdotool, ImageMagick and Tesseract. Build the CLI before the desktop app because both outputs are named `lightwell`:

```sh
npm ci
scripts/verify/doctor.sh
npm run tauri:build -- --debug --no-bundle -- --locked
cp target/debug/lightwell /tmp/lightwell-desktop-proof
scripts/verify/capture-source-files.sh /tmp/lightwell-desktop-proof "$ARTIFACTS"
```

The helper creates an isolated Rust app with `main.rs` and `helpers.rs`, opens the main block through Atlas, changes files using the native selector, invokes **Open in editor**, and returns to the primary file. Its editor probe records the actual launched file path without starting another GUI app.

Expected output:

```text
Block source files switched main.rs -> helpers.rs -> main.rs; external editor received helpers.rs.
```

Keep `source-files-primary.png`, `source-files-helper.png`, `source-files-return.png`, the editor target and OCR/app logs. Review the unmodified screenshots for the file path, file choices, source text and position footer. The editor target log contains a temporary absolute path, so exclude it from public proof. The optional fourth argument `before` captures an older build without the selector.

The helper stops its app/display and removes its temporary fixture and profile. Export evidence before stopping and deleting the proof VM.
