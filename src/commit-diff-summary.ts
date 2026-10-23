import { unmappedFiles } from "./commit-diff.js";
import type { CommitChanges } from "./map-source.js";
import type { DisplayBlock } from "./model.js";

export type CommitDiffEntry =
  | {
    readonly kind: "block";
    readonly blockId: string;
    readonly label: string;
    readonly sourcePath: string | null;
    readonly state: CommitChanges["blocks"][number]["state"];
    readonly added: number;
    readonly removed: number;
  }
  | {
    readonly kind: "file";
    readonly path: string;
    readonly added: number;
    readonly removed: number;
    readonly binary: boolean;
  };

/** Direct block changes and map-external files, sorted for the change list. */
export function commitDiffEntries(
  changes: CommitChanges,
  blockById: ReadonlyMap<string, DisplayBlock>,
): readonly CommitDiffEntry[] {
  const blocks: CommitDiffEntry[] = [...changes.blocks]
    .map((block): CommitDiffEntry => {
      const display = blockById.get(block.blockId);
      return {
        kind: "block",
        blockId: block.blockId,
        label: block.label,
        sourcePath: block.sourcePath ?? display?.sourcePath ?? null,
        state: block.state,
        added: block.added,
        removed: block.removed,
      };
    })
    .sort((left, right) => {
      const leftLabel = left.kind === "block" ? left.label : left.path;
      const rightLabel = right.kind === "block" ? right.label : right.path;
      return leftLabel.localeCompare(rightLabel);
    });

  const mappedPaths = new Set(
    [...blockById.values(), ...changes.blocks].flatMap((block) => (
      block.sourcePath === null ? [] : [block.sourcePath.replaceAll("\\", "/")]
    )),
  );
  const files: CommitDiffEntry[] = unmappedFiles(changes, mappedPaths).map((path): CommitDiffEntry => {
    const file = changes.files.find((entry) => entry.path === path);
    return {
      kind: "file",
      path,
      added: file?.added ?? 0,
      removed: file?.removed ?? 0,
      binary: file?.binary ?? false,
    };
  });

  return [...blocks, ...files];
}

export function wrapCommitDiffIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

/** Block id for a changed file path, when the map has a block for that file. */
export function blockIdForCommitPath(
  path: string,
  changes: CommitChanges,
  blockById: ReadonlyMap<string, DisplayBlock>,
): string | null {
  const normalized = path.replaceAll("\\", "/");
  for (const change of changes.blocks) {
    const display = blockById.get(change.blockId);
    if (display?.sourcePath?.replaceAll("\\", "/") === normalized) return change.blockId;
  }
  for (const display of blockById.values()) {
    if (display.sourcePath?.replaceAll("\\", "/") === normalized) return display.id;
  }
  return null;
}
