# Atlas label detail and source selection

Fit view shows the workspace and top-level folder labels. Nested labels appear as their on-screen width and height become readable while zooming. Tiny truncated prefixes stay hidden even when selected or hovered. Atlas text uses the same monospace font as the Atlas/Modules controls.

Selecting a source-backed Atlas block opens its read-only source in the side panel by default. Selecting another block replaces that source. The existing show-details-first preference still applies; folders retain their folder details.

## Browser regression checks

After `npm ci`, run:

```sh
node_modules/.bin/playwright test e2e/atlas.spec.ts e2e/map.spec.ts e2e/tree.spec.ts e2e/src.spec.ts
```

The Atlas detail and map tests verify the fit/zoom/reset cycle, readable label prefixes, rendered font size and family, and automatic source following selection, including replacing an open file diff. Both desktop and narrow viewports run. A selected tile can remain unlabeled when the narrow viewport leaves too little room; its full name stays in the outline. Run `npm run test:e2e` before submitting changes to shared selection or label policy so older map assertions are covered too.

## Desktop proof on Linux

Requirements: a clean Linux VM with Tauri build dependencies, Xvfb, xdotool, ImageMagick, Tesseract, and a Prismattyc checkout containing `cell_grid.rs`.

Run the doctor before building the desktop app. The CLI and desktop binaries share the output name `lightwell`, so copy the desktop binary before another CLI build:

```sh
scripts/verify/doctor.sh
npm run tauri:build -- --debug --no-bundle -- --locked
cp target/debug/lightwell /tmp/lightwell-desktop-proof
scripts/verify/capture-atlas-detail.sh /tmp/lightwell-desktop-proof "$WORKSPACE" "$ARTIFACTS"
```

The helper opens an isolated app profile and captures `atlas-fit.png`, `atlas-zoom.png`, and `atlas-source.png`. It filters the real workspace to `cell_grid` and selects a matching row with Enter. It never clicks Open source. Expect `Atlas desktop proof captured fit, zoom and automatic source opening.` Inspect the screenshots for group-only fit labels, additional readable labels after zoom, and loaded source in the side panel.

The optional fourth argument `before` captures only the fit view for comparison with an older app binary. The helper stops its app and display and removes its temporary profile. Keep the artifact directory.
