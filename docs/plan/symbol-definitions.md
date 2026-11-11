# Source definition navigation

F12 and Ctrl/Cmd-click resolve the word under the source cursor. The viewer asks its editor source for project definitions once per workspace/map revision, then resolves the word against those definitions and the existing module labels. One target opens in the inspector at its declaration line and column. Unknown names and collisions across files remain no-ops.

## Contract and ownership

```ts
interface SourceDefinition {
  name: string;
  blockId: string;
  line: number;
  column: number;
}
interface MapEditorSource {
  definitions(workspaceId: string): Promise<readonly SourceDefinition[]>;
  // Existing inspection and external-editor operations remain.
}
type InspectedBlockTarget =
  | { kind: "block"; blockId: string }
  | { kind: "definition"; blockId: string; line: number; column: number; revision: number };
```

Rust core owns declaration extraction. It visits only mapped source files, confines canonical paths to the opened workspace, and deduplicates files before parsing. Rust uses `syn`; other supported code languages reuse their existing source parsers. The Tauri adapter runs extraction off the UI thread using the watched map and validates the returned protocol at the TypeScript boundary.

The viewer owns the lazy in-flight index for the current map revision, name ambiguity, and navigation. A symbol and its map outline entry in the same file represent one target; a same-named module in another file makes the word ambiguous. Overloads at distinct declarations stay ambiguous. Normal block selection constructs a block target, clearing a previous definition cursor without requiring every caller to remember a separate reset.

The existing source-inspection effect loads the target block normally and applies a definition's position only at the map revision that produced it. Stale asynchronous lookups cannot navigate after the workspace, inspected block or map revision changes. Refresh invalidates the index. No symbol index is persisted in schema-v1 maps.

## Alternatives

A backend lookup on every F12 would keep the response smaller but repeatedly parse the project for each word. A viewer-side parser/index would duplicate language knowledge and require fetching all source content across the boundary. Returning a declaration index keeps source parsing in core while amortizing work across navigation.

This is unique-name declaration navigation, not compiler-level import, overload or type resolution. Custom language packs retain module-label navigation; declaration extraction uses the built-in code parsers. Multiple files within a block remain a separate feature.
