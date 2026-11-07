# Atlas labels and source selection proof

Captured from the real Tauri desktop app in a clean Ubuntu VM at 1440 × 900. The workspace is a public Prismattyc source snapshot at `2ba47351f62d54c2d05c0bd05c610e771ad08290`, containing 996 blocks and 17 crates. No mocked IPC is used. The screenshots are unmodified native window captures.

The baseline is Lightwell `12a13d7`. The updated app uses implementation `d60a687`; subsequent changes only add this evidence and tighten the capture helper's OCR checks.

| State | Screenshot | Observation |
| --- | --- | --- |
| Before, fit | [before-fit.png](before-fit.png) | Nested boxes contain clipped prefixes. |
| After, fit | [after-fit.png](after-fit.png) | Only the root and top-level groups have labels. |
| After, zoom | [after-zoom.png](after-zoom.png) | Readable nested labels appear in the UI monospace font. |
| After, selection | [after-source.png](after-source.png) | Selecting `cell_grid` opens `crates/prismattyc-core/src/cell_grid.rs` in the source inspector. |

The capture filters the outline to `cell_grid` and selects the last match with Enter. It does not click Open source. The source screenshot shows the loaded Rust implementation.

Commands in the VM, from the repository root:

```sh
npm ci
scripts/verify/doctor.sh
npm run tauri:build -- --debug --no-bundle -- --locked
cp target/debug/lightwell /tmp/lightwell-desktop-proof
scripts/verify/capture-atlas-detail.sh /tmp/lightwell-desktop-proof /tmp/atlas-workspace /tmp/atlas-proof/after
```

Observed output:

```text
verify doctor: ok
Built application at: /tmp/atlas-app/target/debug/lightwell
Atlas desktop proof captured fit, zoom and automatic source opening.
```

Browser regression checks fail against the baseline: fit renders 81 nested labels, and selecting an Atlas block leaves the source inspector closed. The updated app passes all 54 Atlas, tree, and source checks across desktop and narrow viewports, including a rendered label size of 11 pixels, font-family matching, zoom/reset, and source replacement on the next selection. All 381 unit tests pass.

See [the verification feature guide](../../../.cursor/skills/verify-lightwell/features/atlas-detail.md) for prerequisites and cleanup.
