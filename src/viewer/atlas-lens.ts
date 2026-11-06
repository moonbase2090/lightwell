import type { FileTree } from "../file-tree.js";
import type { FactConnection } from "../model.js";

export interface AtlasRelation {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface AtlasLens {
  readonly focusId: string | null;
  readonly focusBlockIds: ReadonlySet<string>;
  readonly relatedBlockIds: ReadonlySet<string>;
  readonly incoming: readonly AtlasRelation[];
  readonly outgoing: readonly AtlasRelation[];
  readonly drawn: readonly AtlasRelation[];
  readonly hiddenCount: number;
}

function subtreeBlockIds(tree: FileTree, focusId: string): Set<string> {
  const result = new Set<string>();
  const pending = [focusId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = tree.nodeById.get(id);
    if (node === undefined) continue;
    if (node.blockId !== null) result.add(node.blockId);
    pending.push(...node.children);
  }
  return result;
}

/** Exact dependency relations for a selected atlas subtree, plus a bounded drawing set. */
export function buildAtlasLens(
  tree: FileTree,
  connections: readonly FactConnection[],
  focusId: string | null,
  edgeLimit = 24,
): AtlasLens {
  if (focusId === null || !tree.nodeById.has(focusId)) {
    return { focusId: null, focusBlockIds: new Set(), relatedBlockIds: new Set(), incoming: [], outgoing: [], drawn: [], hiddenCount: 0 };
  }
  const focusBlockIds = subtreeBlockIds(tree, focusId);
  const incoming: AtlasRelation[] = [];
  const outgoing: AtlasRelation[] = [];
  const relatedBlockIds = new Set(focusBlockIds);
  const seen = new Set<string>();
  for (const connection of connections) {
    if (connection.kind !== "depends_on" || seen.has(connection.id)) continue;
    seen.add(connection.id);
    const sourceInside = focusBlockIds.has(connection.source);
    const targetInside = focusBlockIds.has(connection.target);
    if (sourceInside === targetInside) continue;
    const relation = { id: connection.id, source: connection.source, target: connection.target };
    if (targetInside) incoming.push(relation);
    else outgoing.push(relation);
    relatedBlockIds.add(connection.source);
    relatedBlockIds.add(connection.target);
  }
  const byId = (left: AtlasRelation, right: AtlasRelation) => left.id.localeCompare(right.id);
  incoming.sort(byId);
  outgoing.sort(byId);
  const exact = [...incoming, ...outgoing];
  const drawn = exact.slice(0, Math.max(0, edgeLimit));
  return {
    focusId,
    focusBlockIds,
    relatedBlockIds,
    incoming,
    outgoing,
    drawn,
    hiddenCount: exact.length - drawn.length,
  };
}
