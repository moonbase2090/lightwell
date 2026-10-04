# Lightwell backlog


## Commit diff view (added 2026-10-03)
Pick a git commit (or a range) and see its changes on the map in detail: highlight the blocks and connections that were added, changed or removed, show line counts per block, and let you click a changed block to see its full side-by-side diff. Useful for reviewing a PR or understanding what a commit really touched.

## Code inspector (added 2026-10-03)
Click a block on the map to open its source in a read-only Monaco inspector, scrolled to that block. Include syntax highlighting, go-to-definition within the project, search, and navigation between the block's files. **Open in editor** launches the OS default app by default. Let users override it with an arbitrary command template using file, line, and column placeholders. Fall back to `VISUAL`, then `EDITOR`; ship a few ready-made templates, including JetBrains IDEs, Kiro, Zed, VS Code, Cursor, and vim in a terminal, without hard-coding a supported-editor list. Pairs with the commit diff view, using Monaco's diff mode.

## Brand (finalized)
Name: Lightwell. Tagline: "turning the lights on in the Dark Factory".

## Website art direction (added 2026-10-03)
Atmospheric dark factory: a near-black, moody industrial space with soft volumetric light shafts cutting through haze and lighting up machinery. Use muted colors, silhouettes, side-on depth, and fog. As you scroll, more light shafts open and reveal the map. Use original art only, never game assets. Pair it with the tagline "turning the lights on in the Dark Factory".
