# Lightwell

turning the lights on in the Dark Factory

Lightwell maps Rust workspaces and shows their crates, app entry points, Rust modules, Cargo features, dependency edges, and written product notes in a browser. The checked-in preview maps cover Prismattyc and Scorecard. Extracted facts and preview notes live in separate JSON files.

## Run the viewer

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. The viewer reads its checked-in maps and makes no network requests.

Build the static site with:

```sh
npm run build
```

The output is in `dist/`.

## Desktop shell

Start the Tauri v2 app with the same Vite and React viewer:

```sh
npm ci
npm run tauri:dev
```

Build a local desktop bundle with `npm run tauri:build`. Pull request CI uploads an unsigned Apple Silicon `.app` archive and an x86_64 Linux `.deb` built for a GLIBC 2.28 executable floor. The credential-gated macOS job additionally uploads a signed, notarized, stapled Apple Silicon archive.

In the desktop app, choose **Open workspace** and select a folder with a `Cargo.toml`. Recent workspaces are kept in Lightwell's user config folder, outside the project. The browser preview continues to use the checked-in Prismattyc and Scorecard fixtures.

The desktop Project notes dialog is off in default builds. Enable it when developing the app with:

```sh
VITE_ENABLE_PROJECT_NOTES=true npm run tauri:dev
```

Click **Notes** to add, edit, or remove notes for map blocks. The dialog reads and writes the opened project's `.lightwell/notes.json` file. It marks stale notes and keeps them until you remove them.

## Rust CLI

Install the Rust CLI from the repository root:

```sh
cargo install --path crates/lightwell-cli
```

Extract a map with:

```sh
lightwell extract ../Prismattyc --name Prismattyc -o maps/prismattyc.facts.json
```

The Rust CLI calls `lightwell-core`. It uses `cargo metadata --no-deps` when Cargo is installed and otherwise reads the manifests and Rust sources directly. It records workspace crates, app targets, internal path dependencies, declared Cargo features, Rust modules, and source fingerprints. It omits test-only modules. Paths in each output file are relative to the source repository.

Run `watch` to stream a map and later maps when source fingerprints change:

```sh
lightwell watch ../Prismattyc --name Prismattyc
```

`lightwell watch` writes each complete map to stdout as JSON Lines. Press Ctrl-C to stop it.

CI builds and runs the Rust CLI on macOS with a macOS 11.0 deployment target. Linux CI builds x86_64 and ARM64 binaries with a glibc 2.28 symbol floor and runs each binary on Amazon Linux 2023.

The `npm run lightwell -- ...` command remains available for the TypeScript preview workflow while the app migrates to the shared Rust extractor.

## Open a block in an editor

Run `lightwell open <block-id>` from the workspace root. The command extracts the current map, finds the block source, and opens that file at the start. Schema v1 does not record source spans, so the CLI uses line 1 and column 1.

By default, Lightwell uses `open` on macOS or `xdg-open` on Linux. Set `LIGHTWELL_EDITOR_TEMPLATE` to override the OS handler. Templates accept `{file}`, `{line}`, and `{column}`. Lightwell parses the template into a program and arguments without evaluating it in a shell. If the configured command or OS handler fails, Lightwell tries `VISUAL`, then `EDITOR`.

```sh
LIGHTWELL_EDITOR_TEMPLATE='code --goto {file}:{line}:{column}' lightwell open crate:lightwell-core
```

These templates are examples, not a supported-editor list. Use any command available on your system.

| Editor | Template |
| --- | --- |
| JetBrains IDE | `idea --line {line} --column {column} {file}` |
| Kiro | `kiro {file}` |
| Zed | `zed {file}:{line}:{column}` |
| Visual Studio Code | `code --goto {file}:{line}:{column}` |
| Cursor | `cursor {file}` |
| Vim in a Linux terminal | `x-terminal-emulator -e vim "+call cursor({line},{column})" {file}` |

See the [JetBrains command-line reference](https://www.jetbrains.com/help/idea/opening-files-from-command-line.html), [Zed CLI reference](https://zed.dev/docs/reference/cli), and [Visual Studio Code CLI reference](https://code.visualstudio.com/docs/configure/command-line) for their documented file and location arguments.

## Preview notes

The checked-in preview uses one notes overlay for each map:

```sh
node scripts/seed-annotations.mjs maps/prismattyc.facts.json ../Prismattyc maps/prismattyc.annotations.json
node scripts/seed-annotations.mjs maps/scorecard.facts.json ../Scorecard maps/scorecard.annotations.json
```

The seed command refuses to overwrite an existing overlay. Edit the overlay to change a description, kind, status, feature membership, or feature group. Descriptions come from source documentation or the written project notes in the seeding script.

When a block's fingerprint no longer matches its note, the viewer marks it as changed. Review the block and update its `sourceFingerprint`. Update affected feature `sourceFingerprints` when their descriptions still match the source. Extraction never writes to note overlays.

## Project notes

Save project notes from the workspace root. Lightwell creates `.lightwell/notes.json` on the first save and stores each note by stable block ID with the source fingerprint it describes.

```sh
lightwell extract . -o /tmp/lightwell-map.json
lightwell notes set crate:lightwell-core "Review output serialization"
lightwell notes list
lightwell notes rm crate:lightwell-core
```

Use a `blocks[].id` value from the extracted map. `notes list` extracts the current workspace map and marks a note stale when its block is missing or its source fingerprint changed. Stale notes stay in the file until you remove or replace them. The checked-in browser preview continues to use the separate `maps/*.annotations.json` overlays above. See [the schema reference](docs/schema.md) for both formats.

## Data flow

```text
Cargo.toml and Rust source
          │
          ▼
lightwell extract ──► maps/<project>.facts.json
                           │
             written notes and feature groups
                           ▼
                maps/<project>.annotations.json
                           │
                           ▼
                   Lightwell viewer
```

`src/extract/` owns extraction. `src/schema.ts` validates facts and note overlays, merges them, and marks stale fingerprints. `src/viewer/layout.ts` sends the visible hierarchy to ELK for layered coordinates. React Flow draws the graph and handles zoom and pan.

`App` receives maps through the asynchronous `MapSource` interface. The browser entry injects `fixtureMapSource`, which loads the checked-in Prismattyc and Scorecard facts and annotation files. The app validates each loaded document against the schema before resolving and laying out the map.

The viewer starts at the Cargo workspace. Click a block with children to open it; the breadcrumb returns to parent levels. Hover a node to trace its connections. Search opens the matching block's parent scope. Hover a feature card to highlight its source blocks and draw connector lines from the card to visible nodes.

## Dependencies

The runtime dependencies are React and React DOM (MIT), `@xyflow/react` (MIT), `elkjs` (EPL-2.0 or GPL-3.0-or-later), and `lucide-react` (ISC). Vite is MIT, TypeScript is Apache-2.0, and `tsx` is MIT. `package-lock.json` records resolved versions. Transitive packages also include ISC, BSD-3-Clause, and MPL-2.0 components.

Print the installed npm and Rust dependency license inventories with `npm run check:licenses`.

## License

Lightwell is licensed under the Mozilla Public License 2.0. The source repository remains private.

## Screenshots

The map screenshots are saved separately at `~/Downloads/lightwell/`:

- `prismattyc-overview.png`
- `prismattyc-detail.png`
- `scorecard-overview.png`
- `scorecard-detail.png`
