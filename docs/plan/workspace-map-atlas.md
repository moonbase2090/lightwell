# Workspace map atlas

The workspace atlas is the default map for large repositories. It pairs a stable, space-filling overview with an exact searchable outline. The existing Modules and Files views remain available from the map switcher.

## Interaction model

- The outline is the primary navigation and accessibility surface. It exposes the complete source hierarchy with standard tree semantics.
- The treemap preserves a stable workspace geography. Rectangle area represents descendant block count because the fact schema does not provide line counts.
- Dependencies are hidden at rest. Selecting a block dims unrelated regions and activates a one-hop dependency lens.
- The lens keeps exact incoming and outgoing lists while limiting the canvas to 24 curves. High-degree blocks therefore remain inspectable without turning the overview into an edge cloud.
- Search matches labels and source paths, retaining the ancestors needed to understand each result.
- Double-clicking a region fits it; “Fit workspace” restores the full atlas.

## Data and failure behavior

The atlas derives its groups from the same file outline as the Files view. Layout is deterministic: nodes are ordered by descendant weight, then stable ID. Cycles and repeated nodes are bounded during both weighting and traversal.

`depends_on` and `contains` facts that cross the selected subtree both enter the lens, so the counts match the inspector. The canvas draws `depends_on` curves only. When a block has no depends-on edge, the lens says so and still lists the parent contains link. Internal subtree edges do not count as incoming or outgoing, duplicate connection IDs are ignored, and the exact list is not truncated when canvas drawing is capped.

## Accessibility

The outline uses real `tree` and `treeitem` roles with levels, positions, set sizes, expanded state, and selected state. Arrow keys move between visible rows; left and right collapse or expand branches. The SVG is a complementary overview rather than hundreds of tab stops. Direction is written as `IN` or `OUT`, not conveyed by color alone.

## Verification target

The implementation is exercised against the checked-in Prismattyc workspace map: 502 blocks and 533 connections. Browser coverage verifies that more than 400 atlas cells render, no dependency paths appear at rest, search selects an exact block, and selection reveals the focused lens.
