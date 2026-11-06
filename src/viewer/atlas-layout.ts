import type { FileTree, FileTreeNode } from "../file-tree.js";

export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AtlasCell extends AtlasRect {
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly blockId: string | null;
  readonly folder: boolean;
  readonly depth: number;
  readonly weight: number;
}

const GAP = 2;
const HEADER = 22;

function weightOf(id: string, tree: FileTree, cache: Map<string, number>, visiting: Set<string>): number {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  if (visiting.has(id)) return 1;
  visiting.add(id);
  const node = tree.nodeById.get(id);
  const childWeight = node?.children.reduce((sum, childId) => sum + weightOf(childId, tree, cache, visiting), 0) ?? 0;
  visiting.delete(id);
  const weight = Math.max(node?.blockId === null ? 0 : 1, childWeight, 1);
  cache.set(id, weight);
  return weight;
}

function inset(rect: AtlasRect, amount: number, top: number): AtlasRect {
  const horizontal = Math.min(amount, rect.width * 0.25);
  const insetTop = Math.min(top, rect.height * 0.35);
  const insetBottom = Math.min(amount, (rect.height - insetTop) * 0.25);
  return {
    x: rect.x + horizontal,
    y: rect.y + insetTop,
    width: rect.width - horizontal * 2,
    height: rect.height - insetTop - insetBottom,
  };
}

function splitGroups(nodes: readonly FileTreeNode[], weights: ReadonlyMap<string, number>): [FileTreeNode[], FileTreeNode[]] {
  if (nodes.length <= 1) return [[...nodes], []];
  const total = nodes.reduce((sum, node) => sum + (weights.get(node.id) ?? 1), 0);
  let sum = 0;
  let split = 1;
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const next = sum + (weights.get(nodes[index]!.id) ?? 1);
    if (Math.abs(total / 2 - next) <= Math.abs(total / 2 - sum)) {
      sum = next;
      split = index + 1;
    } else {
      break;
    }
  }
  return [nodes.slice(0, split), nodes.slice(split)];
}

function partition(
  nodes: readonly FileTreeNode[],
  rect: AtlasRect,
  weights: ReadonlyMap<string, number>,
  output: Map<string, AtlasRect>,
): void {
  if (nodes.length === 0) return;
  if (rect.width <= 0 || rect.height <= 0) {
    for (const node of nodes) output.set(node.id, rect);
    return;
  }
  if (nodes.length === 1) {
    output.set(nodes[0]!.id, rect);
    return;
  }
  const [first, second] = splitGroups(nodes, weights);
  const firstWeight = first.reduce((sum, node) => sum + (weights.get(node.id) ?? 1), 0);
  const totalWeight = firstWeight + second.reduce((sum, node) => sum + (weights.get(node.id) ?? 1), 0);
  const ratio = totalWeight === 0 ? 0.5 : firstWeight / totalWeight;
  if (rect.width >= rect.height) {
    const firstWidth = rect.width * ratio;
    partition(first, { ...rect, width: firstWidth }, weights, output);
    partition(second, { x: rect.x + firstWidth, y: rect.y, width: rect.width - firstWidth, height: rect.height }, weights, output);
  } else {
    const firstHeight = rect.height * ratio;
    partition(first, { ...rect, height: firstHeight }, weights, output);
    partition(second, { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: rect.height - firstHeight }, weights, output);
  }
}

/** A stable, dependency-free binary treemap over the exact file outline. */
export function layoutAtlas(tree: FileTree, width: number, height: number): readonly AtlasCell[] {
  const root = tree.nodeById.get(tree.rootId);
  if (root === undefined || width <= 0 || height <= 0) return [];
  const weights = new Map<string, number>();
  weightOf(root.id, tree, weights, new Set());
  const cells: AtlasCell[] = [];
  const visit = (node: FileTreeNode, rect: AtlasRect, depth: number, seen: Set<string>) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    cells.push({ ...rect, id: node.id, parentId: node.parentId, label: node.label, blockId: node.blockId, folder: node.folder, depth, weight: weights.get(node.id) ?? 1 });
    if (node.children.length === 0) return;
    const children = node.children
      .map((id) => tree.nodeById.get(id))
      .filter((child): child is FileTreeNode => child !== undefined)
      .sort((left, right) => (weights.get(right.id) ?? 1) - (weights.get(left.id) ?? 1) || left.id.localeCompare(right.id));
    const childRects = new Map<string, AtlasRect>();
    partition(children, inset(rect, GAP, depth === 0 ? HEADER + 4 : HEADER), weights, childRects);
    for (const child of children) {
      const childRect = childRects.get(child.id);
      if (childRect !== undefined) visit(child, inset(childRect, GAP / 2, GAP / 2), depth + 1, seen);
    }
  };
  visit(root, { x: 0, y: 0, width, height }, 0, new Set());
  return cells;
}
