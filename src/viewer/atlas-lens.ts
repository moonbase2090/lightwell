import type { FileTree } from "../file-tree.js";
import type { FactConnection } from "../model.js";

export interface AtlasRelation {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "contains" | "depends_on";
}

export interface AtlasLens {
  readonly focusId: string | null;
  readonly focusBlockIds: ReadonlySet<string>;
  readonly relatedBlockIds: ReadonlySet<string>;
  readonly incoming: readonly AtlasRelation[];
  readonly outgoing: readonly AtlasRelation[];
  readonly drawn: readonly AtlasRelation[];
  readonly hiddenCount: number;
  /** depends_on edges that cross the focus boundary. Containment is counted separately. */
  readonly dependsOnCount: number;
}

export type AtlasCellTone = "selected" | "context" | "dimmed" | "rest";

function emptyLens(): AtlasLens {
  return {
    focusId: null,
    focusBlockIds: new Set(),
    relatedBlockIds: new Set(),
    incoming: [],
    outgoing: [],
    drawn: [],
    hiddenCount: 0,
    dependsOnCount: 0,
  };
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

/** Parents of a tree node, not including the node itself. */
export function ancestorIds(tree: FileTree, id: string | null): ReadonlySet<string> {
  const ids = new Set<string>();
  if (id === null) return ids;
  let parent = tree.nodeById.get(id)?.parentId ?? null;
  const seen = new Set<string>();
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    ids.add(parent);
    parent = tree.nodeById.get(parent)?.parentId ?? null;
  }
  return ids;
}

/**
 * Folders and ancestors stay at full strength. Only unrelated leaves dim.
 * A search miss dims a leaf the same way, so the matches stay obvious.
 */
export function atlasCellTone(
  cell: { readonly folder: boolean },
  state: {
    readonly selected: boolean;
    readonly focusActive: boolean;
    readonly related: boolean;
    readonly ancestor: boolean;
    readonly searchMiss: boolean;
  },
): AtlasCellTone {
  if (state.selected) return "selected";
  if (state.ancestor || state.related) return "context";
  if (cell.folder) return "rest";
  if (state.focusActive || state.searchMiss) return "dimmed";
  return "rest";
}

/** Containment and depends-on edges that cross the selected subtree. Curves are depends-on only. */
export function buildAtlasLens(
  tree: FileTree,
  connections: readonly FactConnection[],
  focusId: string | null,
  edgeLimit = 24,
): AtlasLens {
  if (focusId === null || !tree.nodeById.has(focusId)) return emptyLens();
  const focusBlockIds = subtreeBlockIds(tree, focusId);
  const incoming: AtlasRelation[] = [];
  const outgoing: AtlasRelation[] = [];
  const relatedBlockIds = new Set(focusBlockIds);
  const seen = new Set<string>();
  for (const connection of connections) {
    if ((connection.kind !== "depends_on" && connection.kind !== "contains") || seen.has(connection.id)) continue;
    seen.add(connection.id);
    const sourceInside = focusBlockIds.has(connection.source);
    const targetInside = focusBlockIds.has(connection.target);
    if (sourceInside === targetInside) continue;
    const relation: AtlasRelation = {
      id: connection.id,
      source: connection.source,
      target: connection.target,
      kind: connection.kind,
    };
    if (targetInside) incoming.push(relation);
    else outgoing.push(relation);
    relatedBlockIds.add(connection.source);
    relatedBlockIds.add(connection.target);
  }
  const byId = (left: AtlasRelation, right: AtlasRelation) => left.id.localeCompare(right.id);
  incoming.sort(byId);
  outgoing.sort(byId);
  const depends = [...incoming, ...outgoing].filter((relation) => relation.kind === "depends_on");
  const drawn = depends.slice(0, Math.max(0, edgeLimit));
  return {
    focusId,
    focusBlockIds,
    relatedBlockIds,
    incoming,
    outgoing,
    drawn,
    hiddenCount: depends.length - drawn.length,
    dependsOnCount: depends.length,
  };
}
