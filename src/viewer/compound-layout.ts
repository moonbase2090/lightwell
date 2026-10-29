import type { ELK as ElkApi, ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api.js";
import type { FactBlockType } from "../model.js";

const LEAF_WIDTH = 222;
const LEAF_HEIGHT = 94;
const SUMMARY_WIDTH = 180;
const SUMMARY_HEIGHT = 64;
const GROUP_HEADER = 28;
const GROUP_PADDING = 16;
const SIBLING_GAP = 16;
const LAYER_GAP = 36;

export const DEFAULT_COMPOUND_LAYOUT_LIMITS: CompoundLayoutLimits = Object.freeze({
  maxBlocks: 800,
  maxEdges: 1_600,
});

export interface CompoundLayoutLimits {
  readonly maxBlocks: number;
  readonly maxEdges: number;
}

export interface CompoundLayoutBlock {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: FactBlockType;
  readonly children: readonly string[];
}

export interface CompoundLayoutConnection {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface CompoundLayoutInput {
  readonly rootId: string;
  readonly blocks: readonly CompoundLayoutBlock[];
  readonly connections: readonly CompoundLayoutConnection[];
  readonly limits: CompoundLayoutLimits;
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface LayoutBounds extends LayoutPoint {
  readonly width: number;
  readonly height: number;
}

interface BlockLayoutNode {
  readonly kind: "block";
  readonly id: string;
  readonly parentId: string | null;
  readonly blockType: FactBlockType;
  readonly hiddenDescendants: number;
  readonly bounds: LayoutBounds;
}

interface SummaryLayoutNode {
  readonly kind: "summary";
  readonly id: string;
  readonly parentId: string;
  readonly hiddenDescendants: number;
  readonly bounds: LayoutBounds;
}

export type CompoundLayoutNode = BlockLayoutNode | SummaryLayoutNode;

export interface CompoundLayoutEdge {
  readonly id: string;
  readonly groupId: string;
  readonly source: string;
  readonly target: string;
  readonly sourceEdgeIds: readonly string[];
  readonly label: string;
  readonly points: readonly [LayoutPoint, LayoutPoint, ...LayoutPoint[]];
}

export interface CompoundLayoutStats {
  readonly inputBlocks: number;
  readonly renderedBlocks: number;
  readonly omittedBlocks: number;
  readonly inputEdges: number;
  readonly renderedEdges: number;
  readonly omittedEdges: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export interface CompoundLayoutResult {
  readonly nodes: readonly CompoundLayoutNode[];
  readonly edges: readonly CompoundLayoutEdge[];
  readonly stats: CompoundLayoutStats;
}

export interface CompoundLayoutEngine {
  layout(input: CompoundLayoutInput): Promise<CompoundLayoutResult>;
  clearCache(): void;
}

interface SelectedBlock {
  readonly kind: "block";
  readonly block: CompoundLayoutBlock;
  readonly hiddenDescendants: number;
}

interface SelectedSummary {
  readonly kind: "summary";
  readonly id: string;
  readonly parentId: string;
  readonly hiddenDescendants: number;
}

type SelectedNode = SelectedBlock | SelectedSummary;

interface ProjectedEdge {
  readonly id: string;
  readonly groupId: string;
  readonly source: string;
  readonly target: string;
  readonly sourceEdgeIds: readonly string[];
  readonly label: string;
}

interface LocalEdge {
  readonly projected: ProjectedEdge;
  readonly points: readonly [LayoutPoint, LayoutPoint, ...LayoutPoint[]];
}

interface ChildPlacement {
  readonly x: number;
  readonly y: number;
  readonly layout: LocalLayout;
}

interface PackedChildren {
  readonly placements: readonly ChildPlacement[];
  readonly width: number;
  readonly height: number;
}

interface LocalLayout {
  readonly node: SelectedNode;
  readonly width: number;
  readonly height: number;
  readonly children: readonly ChildPlacement[];
  readonly edges: readonly LocalEdge[];
}

interface BoundedGraph {
  readonly root: SelectedBlock;
  readonly nodesById: ReadonlyMap<string, SelectedNode>;
  readonly childrenByParent: ReadonlyMap<string, readonly SelectedNode[]>;
  readonly projectedEdgesByGroup: ReadonlyMap<string, readonly ProjectedEdge[]>;
  readonly inputBlocks: number;
  readonly selectedBlocks: number;
  readonly inputEdges: number;
  readonly selectedEdges: number;
}

interface MutableProjectedEdge {
  readonly groupId: string;
  readonly source: string;
  readonly target: string;
  readonly sourceEdgeIds: string[];
}

interface MutableStats {
  cacheHits: number;
  cacheMisses: number;
}

export function createCompoundLayoutEngine(elk: ElkApi): CompoundLayoutEngine {
  const cache = new Map<string, LocalLayout>();

  return {
    async layout(input) {
      const bounded = buildBoundedGraph(input);
      const stats: MutableStats = { cacheHits: 0, cacheMisses: 0 };
      const rootLayout = await layoutNode({
        node: bounded.root,
        graph: bounded,
        elk,
        cache,
        stats,
      });
      const nodes: CompoundLayoutNode[] = [];
      const edges: CompoundLayoutEdge[] = [];
      flattenLayout(rootLayout, 0, 0, nodes, edges);
      return {
        nodes,
        edges,
        stats: {
          inputBlocks: bounded.inputBlocks,
          renderedBlocks: nodes.length,
          omittedBlocks: bounded.inputBlocks - bounded.selectedBlocks,
          inputEdges: bounded.inputEdges,
          renderedEdges: bounded.selectedEdges,
          omittedEdges: bounded.inputEdges - bounded.selectedEdges,
          cacheHits: stats.cacheHits,
          cacheMisses: stats.cacheMisses,
        },
      };
    },
    clearCache() {
      cache.clear();
    },
  };
}

function buildBoundedGraph(input: CompoundLayoutInput): BoundedGraph {
  const limits = normalizeLimits(input.limits);
  const blockById = new Map(input.blocks.map((candidate) => [candidate.id, candidate]));
  const rootBlock = blockById.get(input.rootId);
  if (rootBlock === undefined) throw new Error(`Compound layout root is missing: ${input.rootId}`);

  const dependencyEndpoints = new Set(input.connections.flatMap((edge) => [edge.source, edge.target]));
  const reachable = reachableBlocks(rootBlock, blockById, dependencyEndpoints);
  const reachableIds = new Set(reachable.map((candidate) => candidate.id));
  const descendantCounts = countDescendants(reachable, blockById, reachableIds, dependencyEndpoints);
  const selectedIds = new Set<string>([rootBlock.id]);
  const selectedBlocks: CompoundLayoutBlock[] = [rootBlock];
  const summaries: SelectedSummary[] = [];
  const representativeByBlockId = new Map<string, string>();
  const pending: CompoundLayoutBlock[] = [rootBlock];

  while (pending.length > 0 && selectedBlocks.length + summaries.length < limits.maxBlocks) {
    const parent = pending.shift();
    if (parent === undefined) break;
    const children = orderedChildren(parent, blockById, reachableIds, dependencyEndpoints);
    const remaining = limits.maxBlocks - selectedBlocks.length - summaries.length;
    if (children.length <= remaining) {
      for (const child of children) {
        if (selectedIds.has(child.id)) continue;
        selectedIds.add(child.id);
        selectedBlocks.push(child);
        if (child.children.length > 0) pending.push(child);
      }
      continue;
    }

    const visibleCount = Math.max(0, remaining - 1);
    for (const child of children.slice(0, visibleCount)) {
      if (selectedIds.has(child.id)) continue;
      selectedIds.add(child.id);
      selectedBlocks.push(child);
    }
    const hiddenChildren = children.slice(visibleCount);
    const summary: SelectedSummary = {
      kind: "summary",
      id: summaryId(parent.id),
      parentId: parent.id,
      hiddenDescendants: hiddenChildren.reduce((total, child) => total + (descendantCounts.get(child.id) ?? 1), 0),
    };
    summaries.push(summary);
    for (const hiddenChild of hiddenChildren) {
      mapSubtreeToRepresentative(hiddenChild, summary.id, blockById, representativeByBlockId);
    }
  }

  const selectedNodes: SelectedNode[] = selectedBlocks.map((candidate) => ({
    kind: "block",
    block: candidate,
    hiddenDescendants: Math.max(0, (descendantCounts.get(candidate.id) ?? 1) - countSelectedSubtree(candidate.id, selectedIds, blockById)),
  }));
  selectedNodes.push(...summaries);
  const nodesById = new Map(selectedNodes.map((candidate) => [selectedNodeId(candidate), candidate]));
  const childrenByParent = groupSelectedChildren(selectedNodes, selectedIds, dependencyEndpoints);
  const selectedConnections = input.connections
    .filter((edge) => reachableIds.has(edge.source) && reachableIds.has(edge.target))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limits.maxEdges);
  const projectedEdgesByGroup = projectEdges(
    selectedConnections,
    selectedIds,
    blockById,
    nodesById,
    representativeByBlockId,
  );
  const root = nodesById.get(rootBlock.id);
  if (root?.kind !== "block") throw new Error(`Compound layout root could not be selected: ${rootBlock.id}`);

  return {
    root,
    nodesById,
    childrenByParent,
    projectedEdgesByGroup,
    inputBlocks: reachable.length,
    selectedBlocks: selectedBlocks.length,
    inputEdges: input.connections.length,
    selectedEdges: selectedConnections.length,
  };
}

function normalizeLimits(limits: CompoundLayoutLimits): CompoundLayoutLimits {
  return {
    maxBlocks: Math.max(1, Math.floor(limits.maxBlocks)),
    maxEdges: Math.max(0, Math.floor(limits.maxEdges)),
  };
}

function reachableBlocks(
  root: CompoundLayoutBlock,
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
  dependencyEndpoints: ReadonlySet<string>,
): CompoundLayoutBlock[] {
  const result: CompoundLayoutBlock[] = [];
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || seen.has(current.id)) continue;
    seen.add(current.id);
    result.push(current);
    pending.push(...orderedChildren(current, blockById, null, dependencyEndpoints));
  }
  return result;
}

function countDescendants(
  reachable: readonly CompoundLayoutBlock[],
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
  reachableIds: ReadonlySet<string>,
  dependencyEndpoints: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of [...reachable].reverse()) {
    const children = orderedChildren(candidate, blockById, reachableIds, dependencyEndpoints);
    counts.set(candidate.id, 1 + children.reduce((total, child) => total + (counts.get(child.id) ?? 1), 0));
  }
  return counts;
}

function orderedChildren(
  parent: CompoundLayoutBlock,
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
  allowedIds: ReadonlySet<string> | null,
  dependencyEndpoints: ReadonlySet<string>,
): CompoundLayoutBlock[] {
  return parent.children
    .map((id) => blockById.get(id))
    .filter((candidate): candidate is CompoundLayoutBlock => candidate !== undefined
      && candidate.parentId === parent.id
      && (allowedIds === null || allowedIds.has(candidate.id)))
    .sort((left, right) => childPriority(left, dependencyEndpoints) - childPriority(right, dependencyEndpoints)
      || left.id.localeCompare(right.id));
}

function mapSubtreeToRepresentative(
  root: CompoundLayoutBlock,
  representativeId: string,
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
  representativeByBlockId: Map<string, string>,
): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || representativeByBlockId.has(current.id)) continue;
    representativeByBlockId.set(current.id, representativeId);
    for (const childId of current.children) {
      const child = blockById.get(childId);
      if (child?.parentId === current.id) pending.push(child);
    }
  }
}

function childPriority(block: CompoundLayoutBlock, dependencyEndpoints: ReadonlySet<string>): number {
  if (block.type === "app") return 0;
  if (dependencyEndpoints.has(block.id)) return 1;
  return 2;
}

function countSelectedSubtree(
  rootId: string,
  selectedIds: ReadonlySet<string>,
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
): number {
  let count = 0;
  const seen = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined || seen.has(id) || !selectedIds.has(id)) continue;
    seen.add(id);
    count += 1;
    const current = blockById.get(id);
    if (current !== undefined) pending.push(...current.children);
  }
  return count;
}

function groupSelectedChildren(
  nodes: readonly SelectedNode[],
  selectedIds: ReadonlySet<string>,
  dependencyEndpoints: ReadonlySet<string>,
): ReadonlyMap<string, readonly SelectedNode[]> {
  const groups = new Map<string, SelectedNode[]>();
  for (const node of nodes) {
    const parentId = selectedNodeParentId(node);
    if (parentId === null || !selectedIds.has(parentId)) continue;
    const siblings = groups.get(parentId) ?? [];
    siblings.push(node);
    groups.set(parentId, siblings);
  }
  for (const siblings of groups.values()) {
    siblings.sort((left, right) => selectedPriority(left, dependencyEndpoints) - selectedPriority(right, dependencyEndpoints)
      || selectedNodeId(left).localeCompare(selectedNodeId(right)));
  }
  return groups;
}

function selectedPriority(node: SelectedNode, dependencyEndpoints: ReadonlySet<string>): number {
  if (node.kind === "summary") return 3;
  return childPriority(node.block, dependencyEndpoints);
}

function projectEdges(
  connections: readonly CompoundLayoutConnection[],
  selectedIds: ReadonlySet<string>,
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
  nodesById: ReadonlyMap<string, SelectedNode>,
  representativeByBlockId: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly ProjectedEdge[]> {
  const aggregated = new Map<string, MutableProjectedEdge>();
  for (const connection of connections) {
    const source = representativeByBlockId.get(connection.source)
      ?? nearestSelected(connection.source, selectedIds, blockById);
    const target = representativeByBlockId.get(connection.target)
      ?? nearestSelected(connection.target, selectedIds, blockById);
    if (source === null || target === null || source === target) continue;
    const groupId = lowestCommonAncestor(source, target, nodesById);
    if (groupId === null) continue;
    const projectedSource = directChildOf(groupId, source, nodesById);
    const projectedTarget = directChildOf(groupId, target, nodesById);
    if (projectedSource === null || projectedTarget === null || projectedSource === projectedTarget) continue;
    const key = `${groupId}\0${projectedSource}\0${projectedTarget}`;
    const current = aggregated.get(key);
    if (current === undefined) {
      aggregated.set(key, {
        groupId,
        source: projectedSource,
        target: projectedTarget,
        sourceEdgeIds: [connection.id],
      });
    } else {
      current.sourceEdgeIds.push(connection.id);
    }
  }

  const grouped = new Map<string, ProjectedEdge[]>();
  for (const aggregate of aggregated.values()) {
    const edge: ProjectedEdge = {
      id: `depends:${aggregate.groupId}:${aggregate.source}:${aggregate.target}`,
      groupId: aggregate.groupId,
      source: aggregate.source,
      target: aggregate.target,
      sourceEdgeIds: aggregate.sourceEdgeIds,
      label: aggregate.sourceEdgeIds.length === 1 ? "depends on" : `depends on (${aggregate.sourceEdgeIds.length})`,
    };
    const edges = grouped.get(edge.groupId) ?? [];
    edges.push(edge);
    grouped.set(edge.groupId, edges);
  }
  for (const edges of grouped.values()) edges.sort((left, right) => left.id.localeCompare(right.id));
  return grouped;
}

function nearestSelected(
  id: string,
  selectedIds: ReadonlySet<string>,
  blockById: ReadonlyMap<string, CompoundLayoutBlock>,
): string | null {
  let current = blockById.get(id);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    if (selectedIds.has(current.id)) return current.id;
    seen.add(current.id);
    current = current.parentId === null ? undefined : blockById.get(current.parentId);
  }
  return null;
}

function lowestCommonAncestor(
  source: string,
  target: string,
  nodesById: ReadonlyMap<string, SelectedNode>,
): string | null {
  const sourceAncestors = new Set(ancestorIds(source, nodesById));
  return ancestorIds(target, nodesById).find((id) => sourceAncestors.has(id)) ?? null;
}

function ancestorIds(
  id: string,
  nodesById: ReadonlyMap<string, SelectedNode>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current = nodesById.get(id);
  while (current !== undefined && !seen.has(selectedNodeId(current))) {
    const currentId = selectedNodeId(current);
    seen.add(currentId);
    result.push(currentId);
    const parentId = selectedNodeParentId(current);
    current = parentId === null ? undefined : nodesById.get(parentId);
  }
  return result;
}

function directChildOf(
  ancestorId: string,
  descendantId: string,
  nodesById: ReadonlyMap<string, SelectedNode>,
): string | null {
  let current = nodesById.get(descendantId);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(selectedNodeId(current))) {
    const currentId = selectedNodeId(current);
    seen.add(currentId);
    const parentId = selectedNodeParentId(current);
    if (parentId === ancestorId) return currentId;
    if (parentId === null) return null;
    current = nodesById.get(parentId);
  }
  return null;
}

async function layoutNode(args: {
  readonly node: SelectedNode;
  readonly graph: BoundedGraph;
  readonly elk: ElkApi;
  readonly cache: Map<string, LocalLayout>;
  readonly stats: MutableStats;
}): Promise<LocalLayout> {
  const id = selectedNodeId(args.node);
  const children = args.graph.childrenByParent.get(id) ?? [];
  if (children.length === 0) return leafLayout(args.node);

  const childLayouts: LocalLayout[] = [];
  for (const child of children) {
    childLayouts.push(await layoutNode({ ...args, node: child }));
  }
  const projectedEdges = args.graph.projectedEdgesByGroup.get(id) ?? [];
  const key = cacheKey(args.node, childLayouts, projectedEdges);
  const cached = args.cache.get(key);
  if (cached !== undefined) {
    args.stats.cacheHits += 1;
    return cached;
  }

  args.stats.cacheMisses += 1;
  const layout = projectedEdges.length === 0
    ? packGroup(args.node, childLayouts)
    : await layoutLayeredGroup(args.node, childLayouts, projectedEdges, args.elk);
  args.cache.set(key, layout);
  return layout;
}

function leafLayout(node: SelectedNode): LocalLayout {
  return {
    node,
    width: node.kind === "summary" ? SUMMARY_WIDTH : LEAF_WIDTH,
    height: node.kind === "summary" ? SUMMARY_HEIGHT : LEAF_HEIGHT,
    children: [],
    edges: [],
  };
}

function cacheKey(
  node: SelectedNode,
  children: readonly LocalLayout[],
  edges: readonly ProjectedEdge[],
): string {
  return JSON.stringify([
    selectedNodeId(node),
    node.kind,
    selectedNodeType(node),
    selectedNodeHiddenDescendants(node),
    children.map((child) => [
      selectedNodeId(child.node),
      child.node.kind,
      child.node.kind === "block" ? child.node.block.type : "summary",
      child.width,
      child.height,
      selectedNodeHiddenDescendants(child.node),
    ]),
    edges.map((edge) => [edge.source, edge.target, edge.sourceEdgeIds]),
  ]);
}

function packGroup(node: SelectedNode, children: readonly LocalLayout[]): LocalLayout {
  const packed = packChildren(children);
  return {
    node,
    width: Math.max(LEAF_WIDTH, packed.width + GROUP_PADDING * 2),
    height: Math.max(LEAF_HEIGHT, packed.height + GROUP_HEADER + GROUP_PADDING * 2),
    children: packed.placements.map((placement) => ({
      ...placement,
      x: placement.x + GROUP_PADDING,
      y: placement.y + GROUP_HEADER + GROUP_PADDING,
    })),
    edges: [],
  };
}

function packChildren(children: readonly LocalLayout[], minimumWidth = 0): PackedChildren {
  if (children.length === 0) return { placements: [], width: 0, height: 0 };
  const area = children.reduce((total, child) => total + (child.width + SIBLING_GAP) * (child.height + SIBLING_GAP), 0);
  const widest = Math.max(...children.map((child) => child.width));
  const targetWidth = Math.max(widest, minimumWidth, Math.ceil(Math.sqrt(area * 1.6)));
  const placements: ChildPlacement[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let contentWidth = 0;
  for (const child of children) {
    if (x > 0 && x + child.width > targetWidth) {
      x = 0;
      y += rowHeight + SIBLING_GAP;
      rowHeight = 0;
    }
    placements.push({ x, y, layout: child });
    contentWidth = Math.max(contentWidth, x + child.width);
    rowHeight = Math.max(rowHeight, child.height);
    x += child.width + SIBLING_GAP;
  }
  return { placements, width: contentWidth, height: y + rowHeight };
}

async function layoutLayeredGroup(
  node: SelectedNode,
  children: readonly LocalLayout[],
  edges: readonly ProjectedEdge[],
  elk: ElkApi,
): Promise<LocalLayout> {
  const routedIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  for (const child of children) {
    if (selectedNodeType(child.node) === "app") routedIds.add(selectedNodeId(child.node));
  }
  const flowChildren = children.filter((child) => routedIds.has(selectedNodeId(child.node)));
  const looseChildren = children.filter((child) => !routedIds.has(selectedNodeId(child.node)));
  const elkEdges: ElkExtendedEdge[] = edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));
  const graph: ElkNode = {
    id: `group:${selectedNodeId(node)}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.separateConnectedComponents": "false",
      "elk.spacing.nodeNode": String(SIBLING_GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: flowChildren.map((child) => ({
      id: selectedNodeId(child.node),
      width: child.width,
      height: child.height,
      ...(selectedNodeType(child.node) === "app"
        ? { layoutOptions: { "elk.layered.layering.layerConstraint": "FIRST" } }
        : {}),
    })),
    edges: elkEdges,
  };
  const laidOut = await elk.layout(graph);
  const positions = new Map((laidOut.children ?? []).map((child) => [child.id, {
    x: child.x ?? 0,
    y: child.y ?? 0,
  }]));
  const flowPlacements = flowChildren.map((child) => {
    const position = positions.get(selectedNodeId(child.node)) ?? { x: 0, y: 0 };
    return {
      x: position.x,
      y: position.y,
      layout: child,
    };
  });
  const edgeById = new Map((laidOut.edges ?? []).map((edge) => [edge.id, edge]));
  const flowWidth = Math.max(0, ...flowPlacements.map((placement) => placement.x + placement.layout.width));
  const flowHeight = Math.max(0, ...flowPlacements.map((placement) => placement.y + placement.layout.height));
  const packedLoose = packChildren(looseChildren, flowWidth);
  const looseOffsetY = flowHeight === 0 ? 0 : flowHeight + SIBLING_GAP;
  const placements = [
    ...flowPlacements,
    ...packedLoose.placements.map((placement) => ({ ...placement, y: placement.y + looseOffsetY })),
  ].map((placement) => ({
    ...placement,
    x: placement.x + GROUP_PADDING,
    y: placement.y + GROUP_HEADER + GROUP_PADDING,
  }));
  const routedEdges = edges.map((edge) => ({
    projected: edge,
    points: routedPoints(edgeById.get(edge.id), GROUP_PADDING, GROUP_HEADER + GROUP_PADDING),
  }));
  const contentWidth = Math.max(flowWidth, packedLoose.width);
  const contentHeight = Math.max(flowHeight, looseOffsetY + packedLoose.height);
  return {
    node,
    width: Math.max(LEAF_WIDTH, contentWidth + GROUP_PADDING * 2),
    height: Math.max(LEAF_HEIGHT, contentHeight + GROUP_HEADER + GROUP_PADDING * 2),
    children: placements,
    edges: routedEdges,
  };
}

function routedPoints(edge: ElkExtendedEdge | undefined, offsetX: number, offsetY: number): readonly [LayoutPoint, LayoutPoint, ...LayoutPoint[]] {
  if (edge === undefined) throw new Error("ELK did not return a dependency edge.");
  const section = edge.sections?.[0];
  if (section === undefined) throw new Error(`ELK did not route dependency edge ${edge.id}`);
  const points: ElkPoint[] = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  const translated = points.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY }));
  const start = translated[0];
  const end = translated[1];
  if (start === undefined || end === undefined) throw new Error(`ELK returned an incomplete route for ${edge.id}`);
  return [start, end, ...translated.slice(2)];
}

function flattenLayout(
  layout: LocalLayout,
  absoluteX: number,
  absoluteY: number,
  nodes: CompoundLayoutNode[],
  edges: CompoundLayoutEdge[],
): void {
  const bounds = { x: absoluteX, y: absoluteY, width: layout.width, height: layout.height };
  if (layout.node.kind === "block") {
    nodes.push({
      kind: "block",
      id: layout.node.block.id,
      parentId: layout.node.block.parentId,
      blockType: layout.node.block.type,
      hiddenDescendants: layout.node.hiddenDescendants,
      bounds,
    });
  } else {
    nodes.push({
      kind: "summary",
      id: layout.node.id,
      parentId: layout.node.parentId,
      hiddenDescendants: layout.node.hiddenDescendants,
      bounds,
    });
  }
  for (const edge of layout.edges) {
    const translated = edge.points.map((point) => ({ x: point.x + absoluteX, y: point.y + absoluteY }));
    const start = translated[0];
    const end = translated[1];
    if (start === undefined || end === undefined) continue;
    edges.push({
      ...edge.projected,
      points: [start, end, ...translated.slice(2)],
    });
  }
  for (const child of layout.children) {
    flattenLayout(child.layout, absoluteX + child.x, absoluteY + child.y, nodes, edges);
  }
}

function selectedNodeId(node: SelectedNode): string {
  return node.kind === "block" ? node.block.id : node.id;
}

function selectedNodeParentId(node: SelectedNode): string | null {
  return node.kind === "block" ? node.block.parentId : node.parentId;
}

function selectedNodeType(node: SelectedNode): FactBlockType | null {
  return node.kind === "block" ? node.block.type : null;
}

function selectedNodeHiddenDescendants(node: SelectedNode): number {
  return node.hiddenDescendants;
}

function summaryId(parentId: string): string {
  return `layout-summary:${encodeURIComponent(parentId)}`;
}
