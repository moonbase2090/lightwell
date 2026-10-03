# Codemap

Codemap extracts a Cargo workspace into a local architecture map, then shows the crates, app entry points, Rust modules, Cargo features, dependency edges, and manually grouped product features in a browser.

The checked-in maps cover Prismattyc and Scorecard. Extracted facts and written descriptions live in separate JSON files. Re-running extraction replaces only the facts file. The viewer compares source fingerprints with the annotation overlay and marks changed blocks.

## Run the viewer

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. The viewer reads its checked-in maps and makes no network requests.

Create the static site with:

```sh
npm run build
```

The output is in `dist/`.

## Extract and annotate maps

Run extraction from this project directory. Repository and output paths can be relative:

```sh
npm run codemap -- extract ../Prismattyc --name Prismattyc -o maps/prismattyc.facts.json
npm run codemap -- extract ../Scorecard --name Scorecard -o maps/scorecard.facts.json
```

The extractor runs `cargo metadata --no-deps`, records workspace crates and internal path dependencies, reads declared Cargo features, walks Rust `mod` declarations from Cargo app and library targets, and fingerprints manifests and source files. It omits test-only modules. Paths in the output are relative to each source repository.

Create an initial annotation overlay once for a map:

```sh
node scripts/seed-annotations.mjs maps/prismattyc.facts.json ../Prismattyc maps/prismattyc.annotations.json
node scripts/seed-annotations.mjs maps/scorecard.facts.json ../Scorecard maps/scorecard.annotations.json
```

The seed command refuses to overwrite an existing overlay. Edit the overlay directly to change a description, kind, status, feature membership, or feature group. Descriptions come from source documentation or the written project annotations in the seeding script.

When a block's fingerprint no longer matches its overlay, the viewer marks it as changed. Review the block, update its annotation's `sourceFingerprint`, and update any affected feature `sourceFingerprints` after the description still matches the code. The extractor never writes to annotation files.

See [the schema reference](docs/schema.md) for block types, connection rules, overlay fields, and stale fingerprint behavior.

## Data flow

```text
Cargo.toml and Rust source
          │
          ▼
codemap extract ──► maps/<project>.facts.json
                           │
             written descriptions and feature groups
                           ▼
                maps/<project>.annotations.json
                           │
                           ▼
                  React Flow viewer
```

`src/extract/` owns metadata and Rust module extraction. `src/schema.ts` validates the facts and annotation files at the browser boundary, merges them, and marks stale fingerprints. `src/viewer/layout.ts` sends the visible hierarchy to ELK for layered coordinates. React Flow draws the graph and handles zoom and pan.

The viewer starts at the Cargo workspace. Click a block with children to open it; the breadcrumb returns to parent levels. Hover a node to trace its connections. Search opens the matching block's parent scope. Hover a feature card to highlight its source blocks and draw connector lines from the card to visible nodes.

## Dependencies

The runtime dependencies are React and React DOM (MIT), `@xyflow/react` (MIT), `elkjs` (EPL-2.0 or GPL-3.0-or-later), and `lucide-react` (ISC). Vite is MIT, TypeScript is Apache-2.0, and `tsx` is MIT. `package-lock.json` records resolved versions. Transitive packages also include ISC, BSD-3-Clause, and MPL-2.0 components.

Print the installed dependency license inventory with `npm run check:licenses`.

## Screenshots

The map screenshots are saved separately at `~/Downloads/codemap/`:

- `prismattyc-overview.png`
- `prismattyc-detail.png`
- `scorecard-overview.png`
- `scorecard-detail.png`
