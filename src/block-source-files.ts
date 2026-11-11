import type { FactBlock } from "./model.js";

export interface BlockSourceFile {
  readonly blockId: string;
  readonly path: string;
}

/** Files mapped to a block or its descendants, with the owner's primary file first. */
export function blockSourceFiles(ownerId: string, blocks: ReadonlyMap<string, FactBlock>): readonly BlockSourceFile[] {
  const files = new Map<string, BlockSourceFile>();
  const visited = new Set<string>();
  const pending = [ownerId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const block = blocks.get(id);
    if (block === undefined) continue;
    const path = block.sourcePath ?? (block.type === "module" ? block.declaredByPath : null);
    if (path !== null) {
      const key = path.replaceAll("\\", "/");
      if (!files.has(key)) files.set(key, { blockId: block.id, path });
    }
    pending.push(...block.children.slice().reverse());
  }
  return [...files.values()].sort((a, b) => {
    if (a.blockId === ownerId) return -1;
    if (b.blockId === ownerId) return 1;
    return a.path.localeCompare(b.path);
  });
}
