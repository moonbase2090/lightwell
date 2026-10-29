# Dependency chart layout

This note covers the existing workspace dependency map. A state chart that detects program states and transitions is a separate view and needs its own design note.

## Goals

The dependency chart reads from top to bottom. Entry points appear first, and dependency targets appear below the nodes that depend on them. Workspace, crate, and module boundaries appear as nested dashed boxes. The renderer uses orthogonal dependency edges, short labels, a node-kind legend, and the existing blueprint grid.

The layout must stay responsive when a workspace contains thousands of blocks. A large map can collapse detail, but it must not leave the app's main thread busy while ELK processes an unbounded graph.

## Current behavior

`src/viewer/layout.ts` sends one flat graph to ELK on the main thread. It includes containment edges, asks ELK for splines, discards ELK's routed edge sections, and lets React Flow route each edge again. The layout runs again whenever its React effect receives a new graph input.

One baseline run produced these results with the current options. Times are samples, not performance budgets.

| Map | Blocks | Connections | Time | Bounds |
| --- | ---: | ---: | ---: | ---: |
| checked-in Scorecard map | 145 | 156 | 128 ms | 18,428 x 2,072 px |
| checked-in Prismattyc map | 502 | 533 | 157 ms | 83,043 x 5,826 px |
| Lightwell extracted from this revision | 771 | 814 | 610 ms | 132,214 x 5,744 px |
| synthetic map | 2,000 | 3,978 | 3,396 ms | 66,266 x 73,645 px |

The wide bounds come mainly from treating containment as edges between ordinary nodes. A trial that put the 502-node map into one ELK compound run was still about 86,000 pixels wide because ELK placed many disconnected descendants on one rank. The implementation will not use one global `INCLUDE_CHILDREN` run.

## Decision

Keep `elkjs` and run it in a dedicated web worker. Use recursive layouts that only connect siblings within one group.

The layout pipeline is:

1. Build the visible workspace, crate, and module tree from `parentId` and `children`. Containment becomes nesting, so the canvas no longer draws `contains` edges.
2. Assign each `depends_on` edge to the lowest common ancestor of its source and target. At that ancestor, project each endpoint to the direct child that contains it. Combine edges with the same projected endpoints, but retain the original edge IDs for hover and inspection.
3. Lay out groups from the leaves upward. Use ELK Layered with `DOWN` and `ORTHOGONAL` when a group has projected dependency edges. Use deterministic rectangular packing when a group has no dependency edges. Child group sizes are inputs to the parent's run.
4. Put `app` blocks in the first layer. Dependency edges keep their real source-to-target direction. ELK may route an edge up the side when it breaks a dependency cycle.
5. Add a fixed group header and padding, then convert child coordinates to positions relative to their React Flow parent. Parent nodes precede their children in the returned array.
6. Render the bend points from ELK with a custom orthogonal edge. Place the label on the longest horizontal segment. The current schema has no call relation, so this feature labels only real `depends_on` facts. A future call extractor can use the same label slot without inventing call edges now.

This recursive assignment keeps an edge inside its lowest common group. The router sees every sibling box at that level as an obstacle, so an edge does not pass through an unrelated group. When an edge represents dependencies hidden inside two collapsed groups, its label includes the count and its metadata retains the exact source edges.

ELK remains in the viewer instead of moving to Rust. The browser preview and the desktop app then share one implementation, the existing dependency stays in use, and layout does not add another Tauri command.

## Spacing and visual rules

Leaf cards keep a fixed measured size. Groups reserve 28 pixels for the title, 16 pixels of inner padding, 16 pixels between siblings, and 36 pixels between dependency layers. A disconnected group uses shelf packing with a target width derived from the square root of its child area. These values are inputs to tests rather than scattered CSS constants.

Workspace, crate, and module groups use dashed borders. Workspaces, entry points, crates, modules, and Cargo features use separate colors in the legend. The blueprint theme keeps its major and minor grid. Other app chrome continues to follow the selected theme.

Dependency edges use `depends on` for one fact and `depends on (N)` for an aggregate. Labels use an opaque background and stay outside node and group interiors. The renderer omits a label only when the available horizontal segment is shorter than the measured label.

## Work bounds and updates

The host builds a bounded layout request before it contacts the worker. The initial limits are 800 rendered blocks and 1,600 rendered dependency edges. Lightwell's current 771-block map fits under the block limit. A larger workspace expands groups breadth first, with entry points and dependency endpoints before unconnected children. The remaining descendants become a collapsed summary box that opens that group when selected.

Each group layout has a cache key from its child IDs, child sizes, projected edges, label scale, and spacing version. A local expansion invalidates that group and its ancestors, not unrelated groups. Hover, selection, note state, and commit-diff colors do not invalidate layout.

Every worker request has a generation number. A newer topology request terminates the old worker, starts a new one, and discards any late result. A two-second watchdog retries once with a 400-block limit. If that retry fails, the canvas reports the layout error and keeps navigation available instead of showing an endless preparing state.

## Tests and proof

The implementation adds geometry tests with literal fixtures and assertions on user-visible results:

- Every pair of sibling rectangles has no interior overlap.
- Packed siblings have a 16-pixel gap. Layered siblings in the compact fixture have no nearest-neighbor gap above 64 pixels.
- Every edge segment is horizontal or vertical.
- An edge does not intersect an unrelated node or group interior.
- Entry points are above non-entry siblings, and a dependency source is above its target when the edge is not part of a cycle.
- A 5,000-block synthetic workspace returns no more than the configured block and edge limits within five seconds on the CI runner. Removing the selector limit makes the count assertion fail.

App proof uses only real extraction output. Capture the Lightwell workspace and one larger public repository in the running app. The captures must show nested groups, the legend, orthogonal labelled edges, and the control that opens collapsed detail. Record the worker time and rendered block count with each capture. Do not edit the images after capture.

## Delivery slices

1. Land this design note as a docs pull request.
2. Add the bounded graph builder, recursive ELK worker, layout cache, and geometry and performance tests behind a default-off feature flag.
3. Add group nodes, orthogonal edges, the legend, blueprint styling, and real-repository captures while the flag remains off by default.
4. Enable the dependency chart after the implementation proof is green.

The later state-chart work starts with a separate note about detecting explicit states and transition evidence from source. It does not share extraction rules or a view with this dependency chart.
