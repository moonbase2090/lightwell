import { unmappedFiles } from "./commit-diff.js";
import type { CommitChanges } from "./map-source.js";
import type { DisplayBlock } from "./model.js";

export type CommitDiffEntry =
  | {
    readonly kind: "block";
    readonly blockId: string;
    readonly label: string;
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
    .map((block) => {
      const display = blockById.get(block.blockId);
      return {
        kind: "block",
        blockId: block.blockId,
        label: display?.label ?? block.blockId,
        added: block.added,
        removed: block.removed,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));

  const mappedPaths = new Set(
    [...blockById.values()].flatMap((block) => (
      block.sourcePath === null ? [] : [block.sourcePath.replaceAll("\\", "/")]
    )),
  );
  const files: CommitDiffEntry[] = unmappedFiles(changes, mappedPaths).map((path) => {
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
