export const DEFAULT_MAP_DEPTH = 2;

export type MapDepth = number | "all";

export interface DepthNode {
  readonly id: string;
  readonly children: readonly string[];
}

export interface MapDepthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function mapDepthStorageKey(workspaceId: string): string {
  return `lightwell.map-depth.v1:${encodeURIComponent(workspaceId)}`;
}

export function parseMapDepth(value: string | null): MapDepth {
  if (value === "all") return "all";
  if (value === null) return DEFAULT_MAP_DEPTH;
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 1 ? depth : DEFAULT_MAP_DEPTH;
}

export function readMapDepth(storage: MapDepthStorage | null, workspaceId: string): MapDepth {
  if (storage === null) return DEFAULT_MAP_DEPTH;
  try {
    return parseMapDepth(storage.getItem(mapDepthStorageKey(workspaceId)));
  } catch {
    return DEFAULT_MAP_DEPTH;
  }
}

export function writeMapDepth(storage: MapDepthStorage | null, workspaceId: string, depth: MapDepth): void {
  if (storage === null) return;
  try {
    storage.setItem(mapDepthStorageKey(workspaceId), depth === "all" ? "all" : String(depth));
  } catch {
    // The map still uses the chosen depth for this session.
  }
}

export function subtreeDepth<T extends DepthNode>(scope: T, blockById: ReadonlyMap<string, T>): number {
  let deepest = 1;
  for (const entry of walk(scope, blockById)) deepest = Math.max(deepest, entry.level);
  return deepest;
}

export function blocksWithinDepth<T extends DepthNode>(
  scope: T,
  depth: MapDepth,
  blockById: ReadonlyMap<string, T>,
): T[] {
  const limit = depth === "all" ? Number.POSITIVE_INFINITY : depth;
  return walk(scope, blockById)
    .filter((entry) => entry.level <= limit)
    .map((entry) => entry.node);
}

/** Levels for the control. All is always available. The list stops at 12 unless the saved value is deeper. */
export function depthOptions(maxDepth: number, current: MapDepth): readonly MapDepth[] {
  const currentLevel = current === "all" ? 0 : current;
  const top = Math.min(12, Math.max(1, maxDepth, Number.isInteger(currentLevel) ? currentLevel : 1));
  const options: MapDepth[] = [];
  for (let level = 1; level <= top; level += 1) options.push(level);
  if (current !== "all" && current > top) options.push(current);
  options.push("all");
  return options;
}

function walk<T extends DepthNode>(scope: T, blockById: ReadonlyMap<string, T>): { node: T; level: number }[] {
  const entries: { node: T; level: number }[] = [];
  const seen = new Set<string>();
  const pending: { node: T; level: number }[] = [{ node: scope, level: 1 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || seen.has(current.node.id)) continue;
    seen.add(current.node.id);
    entries.push(current);
    for (const childId of current.node.children) {
      if (seen.has(childId)) continue;
      const child = blockById.get(childId);
      if (child !== undefined) pending.push({ node: child, level: current.level + 1 });
    }
  }
  return entries;
}
