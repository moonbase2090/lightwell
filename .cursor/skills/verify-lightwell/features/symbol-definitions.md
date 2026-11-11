# Project symbol definitions

In a source inspector, F12 or Ctrl/Cmd-click opens a unique project declaration at its source position. Module-name navigation remains available. Unknown names, overloads and names colliding across files leave the current source open. Returning to a file through the outline resets a definition-specific position to that block's normal position.

The index uses mapped source files and the built-in source parsers. Rust identifier columns use UTF-16 units for Monaco; parsers with line-only positions navigate to the start of the declaration line. This is declaration-name lookup, not compiler import, overload or type resolution. Unsupported custom code parsers retain module-name navigation.

## Browser checks

```sh
npm ci
node_modules/.bin/playwright test e2e/definitions.spec.ts
npm run test:e2e
```

The definition checks run at desktop and narrow widths. They exercise F12 and modifier-click, module fallback, unknown and ambiguous names, index reuse, watched-map invalidation, normal-selection reset, and ignoring a slow response after selecting another or the same file.

## Real Linux desktop proof

Use a clean Linux VM with the Tauri build dependencies, Git, Xvfb, xdotool, ImageMagick and Tesseract installed. Run the doctor before the desktop build, then copy the desktop binary because CLI builds use the same output name:

```sh
scripts/verify/doctor.sh
npm run tauri:build -- --debug --no-bundle -- --locked
cp target/debug/lightwell /tmp/lightwell-desktop-proof
scripts/verify/capture-definitions.sh /tmp/lightwell-desktop-proof "$ARTIFACTS"
```

The helper creates an isolated Rust workspace and app profile, opens `src/main.rs` in Atlas, and presses F12 on `calculate`. Expect `src/helpers.rs` at line 4, column 8. It then returns to main and presses F12 on a name defined in both files; the caller must remain open. The desktop app uses its real extraction, project-definition command and source inspector, with no mocked IPC.

Expected output:

```text
Definition navigation opened helpers.rs at line 4 column 8; ambiguous name left main.rs open.
```

Keep `definition-call.png`, `definition-after.png`, `definition-ambiguous.png` and the OCR/app logs. Review the screenshots for the actual source path, declaration text and position footer. An optional fourth argument `before` captures the older app leaving the caller open. The helper stops its app/display and removes its temporary profile and fixture; evidence stays in the artifact directory. Stop and delete the proof VM after exporting evidence.
