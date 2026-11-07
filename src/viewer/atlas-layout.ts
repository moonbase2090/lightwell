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

/** Leaf files under one folder stop growing the folder once this many are counted. */
export const FOLDER_WEIGHT_CAP = 16;

function weightOf(id: string, tree: FileTree, cache: Map<string, number>, visiting: Set<string>): number {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  if (visiting.has(id)) return 1;
  visiting.add(id);
  const node = tree.nodeById.get(id);
  let folderWeight = 0;
  let leafWeight = 0;
  for (const childId of node?.children ?? []) {
    const childWeight = weightOf(childId, tree, cache, visiting);
    if (tree.nodeById.get(childId)?.folder === true) folderWeight += childWeight;
    else leafWeight += childWeight;
  }
  visiting.delete(id);
  const self = node?.blockId === null ? 0 : 1;
  const weight = Math.max(self, folderWeight + Math.min(leafWeight, FOLDER_WEIGHT_CAP), 1);
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

/** Fit a label into a pixel width. A short name is unchanged. A long name ends with an ellipsis. */
export function ellipsizeLabel(label: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0 || fontSize <= 0) return "";
  const maxChars = Math.floor(maxWidth / (fontSize * 0.92));
  if (maxChars <= 0) return "";
  if (label.length <= maxChars) return label;
  if (maxChars === 1) return "…";
  return `${label.slice(0, maxChars - 1)}…`;
}

/** Keep the overview to groups, then reveal labels only when their screen area is readable. */
export function atlasLabel(
  cell: Pick<AtlasCell, "label" | "depth" | "folder" | "width" | "height">,
  zoomScale: number,
  fontSize: number,
): string {
  if (zoomScale <= 1.01 && (cell.depth > 1 || (cell.depth === 1 && !cell.folder))) return "";
  const headerHeight = cell.folder ? Math.min(cell.height, HEADER) : cell.height;
  if (headerHeight * zoomScale < fontSize + 8) return "";
  const label = ellipsizeLabel(cell.label, cell.width * zoomScale - 10, fontSize);
  return label.endsWith("…") && label.length < 8 ? "" : label;
}

export function zoomAbout(rect: AtlasRect, factor: number, anchorX: number, anchorY: number): AtlasRect {
  return {
    x: anchorX - (anchorX - rect.x) * factor,
    y: anchorY - (anchorY - rect.y) * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

export function panRect(rect: AtlasRect, dx: number, dy: number): AtlasRect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/** Keep a frame inside the atlas and at least `minSize` on each side. */
export function clampFrame(rect: AtlasRect, bounds: AtlasRect, minSize = 48): AtlasRect {
  const width = Math.min(bounds.width, Math.max(Math.min(minSize, bounds.width), rect.width));
  const height = Math.min(bounds.height, Math.max(Math.min(minSize, bounds.height), rect.height));
  const x = Math.min(bounds.x + bounds.width - width, Math.max(bounds.x, rect.x));
  const y = Math.min(bounds.y + bounds.height - height, Math.max(bounds.y, rect.y));
  return { x, y, width, height };
}

/** Fit one region, with a little padding, without jumping back to the whole atlas. */
export function frameCell(cell: AtlasRect, bounds: AtlasRect): AtlasRect {
  const pad = Math.max(8, Math.min(cell.width, cell.height) * 0.04);
  return clampFrame(
    { x: cell.x - pad, y: cell.y - pad, width: cell.width + pad * 2, height: cell.height + pad * 2 },
    bounds,
    Math.min(48, bounds.width, bounds.height),
  );
}

/**
 * Frame a selected cell large enough to read, and include a parent that is
 * not much bigger than that window.
 */
export function frameFocus(cell: AtlasRect, bounds: AtlasRect, parent?: AtlasRect): AtlasRect {
  // Keep the cell near a quarter of the frame so a small module stays readable.
  const width = Math.min(bounds.width, Math.max(cell.width * 2.8, Math.min(cell.width / 0.22, bounds.width * 0.55)));
  const height = Math.min(bounds.height, Math.max(cell.height * 2.8, Math.min(cell.height / 0.22, bounds.height * 0.55)));
  let x = cell.x + cell.width / 2 - width / 2;
  let y = cell.y + cell.height / 2 - height / 2;
  let frameWidth = width;
  let frameHeight = height;
  if (
    parent !== undefined &&
    parent.width <= width * 1.25 &&
    parent.height <= height * 1.25
  ) {
    const left = Math.min(x, parent.x);
    const top = Math.min(y, parent.y);
    x = left;
    y = top;
    frameWidth = Math.max(x + frameWidth, parent.x + parent.width) - x;
    frameHeight = Math.max(y + frameHeight, parent.y + parent.height) - y;
  }
  return clampFrame({ x: x - 8, y: y - 8, width: frameWidth + 16, height: frameHeight + 16 }, bounds);
}

/** Frame a tight cluster of matches. A spread-out query frames the first match. */
export function frameMatches(matches: readonly AtlasRect[], bounds: AtlasRect): AtlasRect {
  const first = matches[0];
  if (first === undefined) return bounds;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.width;
  let maxY = first.y + first.height;
  for (const cell of matches) {
    minX = Math.min(minX, cell.x);
    minY = Math.min(minY, cell.y);
    maxX = Math.max(maxX, cell.x + cell.width);
    maxY = Math.max(maxY, cell.y + cell.height);
  }
  const union = { x: minX, y: minY, width: Math.max(8, maxX - minX), height: Math.max(8, maxY - minY) };
  if (union.width <= bounds.width * 0.72 && union.height <= bounds.height * 0.72) return frameFocus(union, bounds);
  return frameFocus(first, bounds);
}
