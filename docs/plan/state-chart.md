# State chart

The state chart is a separate view from the workspace dependency chart. It reads one selected source file and draws state machines found in that file. It does not turn modules or dependency facts into states.

## Detection scope

The first version supports explicit state models in Rust and TypeScript or JavaScript source.

For Rust, a machine starts with an enum whose variants are plain states. The detector records transitions only when a `match` arm names a source variant and the arm returns or assigns another variant from the same enum. A `#[default]` variant becomes the initial state. Payload variants remain states, but their fields do not appear in the chart.

For TypeScript and JavaScript, a machine starts with an `enum`. The detector records transitions only when a `switch` case names a source member and the case returns or assigns another member from that enum. String unions and arbitrary string assignments are out of scope because the type name is not present at runtime and matching them across a file would create plausible but false transitions.

The detector ignores comments, strings, examples written inside them, transitions between different enums, and enum declarations with no transition evidence. It keeps the source line for each state and transition. Duplicate transitions merge only when their machine, source, target, and label match.

This is intentionally conservative. A chart with missing transitions is more useful than a confident chart assembled from unrelated identifiers.

## View and data flow

An exact-true `VITE_ENABLE_STATE_CHART` build flag adds a States control beside the existing Modules and Files controls. The flag is off by default. The default build omits the detector and state-chart renderer.

The user selects a source-backed block, then opens States. The app loads that block through the existing `MapEditorSource.inspectBlock` boundary. The detector receives the returned path and content. No package manager, registry, CDN, dynamic import, or network request participates in detection or rendering.

The view has four states:

1. No source-backed block is selected.
2. Source is loading.
3. Detection returned one or more machines.
4. Detection returned no supported machine or failed.

Each result names the source file and machine. A state or transition retains its source line so a later slice can open the exact evidence in the source inspector.

## Layout and rendering

The renderer uses a deterministic top-down layout implemented in the state-chart module. It does not load a layout package at runtime.

Each enum is a dashed region. States are fixed-size cards. Initial states appear first, and the remaining states are ranked by transitions. Strongly connected states share a rank so cycles do not cause an endless walk. Disconnected states use compact shelf packing below connected states. Edges use orthogonal segments and short labels taken from the `match` arm or `switch` case when a concise guard or event name is present.

Work is capped at 120 states and 240 transitions per source file. Extra states appear in a summary card. The detector scans the source once, and layout is linear in the bounded chart size.

The chart uses the existing blueprint background. Initial, ordinary, terminal, and collapsed states have separate legend colors. Terminal means the detected graph has no outgoing transition from that state. It does not claim the program cannot leave that state through code the detector did not recognize.

## Tests and proof

Tests use literal source fixtures and assert the public result. Every detection and view branch has a test that fails when that branch is removed:

- Rust enums, default states, payload variants, match returns, match assignments, comments, cross-enum references, and unsupported source.
- TypeScript enums, switch returns, switch assignments, comments, cross-enum references, and unsupported string unions.
- Duplicate merging, state and transition bounds, cycles, disconnected states, orthogonal routes, and sibling non-overlap.
- The exact-true feature gate, disabled default, loading, empty, error, ready, and source-selection states.

App proof uses a real source file containing an explicit state machine. The captured image comes from the running app with the feature flag enabled. The default build must contain no state-chart detector or renderer chunk.
