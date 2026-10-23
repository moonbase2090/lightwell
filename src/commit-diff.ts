import type { CommitChanges, ConnectionChangeState } from "./map-source.js";

export interface BlockDiff {
  readonly added: number;
  readonly removed: number;
  /** True when the commit changed this block's own lines; false when only blocks inside it changed. */
  readonly direct: boolean;
}

/**
 * Changed blocks plus every ancestor that contains one, so a collapsed scope
 * still lights up. Counts roll up only until the nearest ancestor with a direct
 * change, because that ancestor's own count already covers its file. A Python
 * module and its symbols share one file, so rolling both upward would count
 * the same lines twice.
 */
export function rollUpChanges(
  changes: CommitChanges,
  parentOf: (blockId: string) => string | null | undefined,
): ReadonlyMap<string, BlockDiff> {
  const direct = new Map(changes.blocks.map((block) => [block.blockId, block] as const));
  const result = new Map<string, { added: number; removed: number; direct: boolean }>();
  for (const block of changes.blocks) {
    result.set(block.blockId, { added: block.added, removed: block.removed, direct: true });
  }
  for (const block of changes.blocks) {
    let ancestor = block.parentId;
    while (ancestor !== null && !direct.has(ancestor)) {
      const entry = result.get(ancestor) ?? { added: 0, removed: 0, direct: false };
      entry.added += block.added;
      entry.removed += block.removed;
      result.set(ancestor, entry);
      ancestor = parentOf(ancestor) ?? null;
    }
  }
  return result;
}

/** Changed files with no block in the map, such as docs or config outside any crate. */
export function unmappedFiles(changes: CommitChanges, mappedPaths: ReadonlySet<string>): readonly string[] {
  return changes.files.map((file) => file.path).filter((path) => !mappedPaths.has(path));
}

export function connectionChangesById(
  changes: CommitChanges,
): ReadonlyMap<string, ConnectionChangeState> {
  return new Map(changes.connections.map((connection) => [connection.id, connection.state]));
}
