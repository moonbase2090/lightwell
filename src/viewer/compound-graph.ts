import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { DisplayBlock, FactConnection } from "../model.js";
import { edgeLabelFontSize } from "../type-scale.js";
import type { BlockNodeData, MapNode } from "./BlockNode.js";
import {
  DEFAULT_COMPOUND_LAYOUT_LIMITS,
  type CompoundLayoutEdge,
  type CompoundLayoutInput,
  type CompoundLayoutNode,
  type CompoundLayoutResult,
  type LayoutBounds,
  type LayoutPoint,
} from "./compound-layout.js";

export interface CompoundGroupNodeData extends BlockNodeData {
  readonly hiddenDescendants: number;
}

export interface CompoundSummaryNodeData extends BlockNodeData {
  readonly hiddenDescendants: number;
}

export type CompoundGroupNode = Node<CompoundGroupNodeData, "compoundGroup">;
export type CompoundSummaryNode = Node<CompoundSummaryNodeData, "compoundSummary">;
export type CompoundGraphNode = MapNode | CompoundGroupNode | CompoundSummaryNode;

export interface OrthogonalEdgeData extends Record<string, unknown> {
  readonly points: readonly [LayoutPoint, LayoutPoint, ...LayoutPoint[]];
  readonly labelPosition: LayoutPoint | null;
  readonly sourceEdgeIds: readonly string[];
}

export type OrthogonalEdge = Edge<OrthogonalEdgeData, "orthogonal">;

export interface CompoundGraph {
  readonly nodes: CompoundGraphNode[];
  readonly edges: OrthogonalEdge[];
}

export function buildCompoundLayoutInput(args: {
  readonly rootId: string;
  readonly blocks: readonly DisplayBlock[];
  readonly connections: readonly FactConnection[];
}): CompoundLayoutInput {
  const visibleIds = new Set(args.blocks.map((block) => block.id));
  return {
    rootId: args.rootId,
    blocks: args.blocks.map((block) => ({
      id: block.id,
      parentId: block.parentId,
      type: block.type,
      children: block.children,
    })),
    connections: args.connections
      .filter((connection) => connection.kind === "depends_on"
        && visibleIds.has(connection.source)
        && visibleIds.has(connection.target))
      .map((connection) => ({
        id: connection.id,
        source: connection.source,
        target: connection.target,
      })),
    limits: DEFAULT_COMPOUND_LAYOUT_LIMITS,
  };
}

export function buildCompoundGraph(args: {
  readonly rootId: string;
  readonly blocks: readonly DisplayBlock[];
  readonly layout: CompoundLayoutResult;
  readonly labelScale: number;
}): CompoundGraph {
  const blockById = new Map(args.blocks.map((block) => [block.id, block]));
  const layoutById = new Map(args.layout.nodes.map((node) => [node.id, node]));
  const groupIds = new Set(
    args.layout.nodes
      .map((node) => node.parentId)
      .filter((parentId): parentId is string => parentId !== null && layoutById.has(parentId)),
  );
  const nodes = args.layout.nodes.map((node): CompoundGraphNode => {
    const parent = parentLayoutNode(node, args.rootId, layoutById);
    const position = parent === undefined
      ? { x: node.bounds.x, y: node.bounds.y }
      : { x: node.bounds.x - parent.bounds.x, y: node.bounds.y - parent.bounds.y };
    if (node.kind === "summary") {
      const block = requiredBlock(blockById, node.parentId);
      return withParent({
        id: node.id,
        type: "compoundSummary",
        position,
        width: node.bounds.width,
        height: node.bounds.height,
        style: { width: node.bounds.width, height: node.bounds.height },
        data: {
          ...blockNodeData(block),
          hiddenDescendants: node.hiddenDescendants,
        },
        ariaLabel: `${node.hiddenDescendants} hidden blocks in ${block.label}`,
      }, parent);
    }

    const block = requiredBlock(blockById, node.id);
    if (groupIds.has(node.id)) {
      return withParent({
        id: node.id,
        type: "compoundGroup",
        position,
        width: node.bounds.width,
        height: node.bounds.height,
        style: { width: node.bounds.width, height: node.bounds.height },
        data: {
          ...blockNodeData(block),
          hiddenDescendants: node.hiddenDescendants,
        },
        ariaLabel: `${block.label}, ${block.type} group`,
      }, parent);
    }

    return withParent({
      id: node.id,
      type: "codeBlock",
      position,
      width: node.bounds.width,
      height: node.bounds.height,
      data: blockNodeData(block),
    }, parent);
  });

  return {
    nodes,
    edges: args.layout.edges.map((edge) => compoundEdge(edge, args.labelScale)),
  };
}

export function orthogonalEdgeGeometry(args: {
  readonly points: readonly [LayoutPoint, LayoutPoint, ...LayoutPoint[]];
  readonly label: string;
  readonly labelScale: number;
}): { readonly path: string; readonly labelPosition: LayoutPoint | null } {
  const path = args.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${formatCoordinate(point.x)} ${formatCoordinate(point.y)}`)
    .join(" ");
  const horizontalSegments = args.points.slice(1).flatMap((end, index) => {
    const start = args.points[index];
    if (start === undefined || start.y !== end.y) return [];
    return [{ start, end, length: Math.abs(end.x - start.x) }];
  });
  const longest = horizontalSegments.sort((left, right) => right.length - left.length)[0];
  const labelWidth = args.label.length * edgeLabelFontSize(args.labelScale) * 0.62 + 16;
  return {
    path,
    labelPosition: longest === undefined || longest.length < labelWidth
      ? null
      : {
          x: (longest.start.x + longest.end.x) / 2,
          y: longest.start.y,
        },
  };
}

function compoundEdge(edge: CompoundLayoutEdge, labelScale: number): OrthogonalEdge {
  const geometry = orthogonalEdgeGeometry({ points: edge.points, label: edge.label, labelScale });
  return {
    id: edge.id,
    type: "orthogonal",
    source: edge.source,
    target: edge.target,
    animated: false,
    label: geometry.labelPosition === null ? undefined : edge.label,
    labelStyle: {
      fill: "#c7dcf3",
      fontSize: edgeLabelFontSize(labelScale),
      fontWeight: 600,
    },
    labelBgStyle: { fill: "#123e73", fillOpacity: 0.96 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#a7c9ec", width: 12, height: 12 },
    interactionWidth: 16,
    style: { stroke: "#a7c9ec", strokeWidth: 1.4, opacity: 0.72 },
    data: {
      points: edge.points,
      labelPosition: geometry.labelPosition,
      sourceEdgeIds: edge.sourceEdgeIds,
    },
  };
}

function blockNodeData(block: DisplayBlock): BlockNodeData {
  return {
    block,
    dimmed: false,
    highlighted: false,
    onHover: () => undefined,
    onActivate: () => undefined,
  };
}

function parentLayoutNode(
  node: CompoundLayoutNode,
  rootId: string,
  layoutById: ReadonlyMap<string, CompoundLayoutNode>,
): CompoundLayoutNode | undefined {
  if (node.id === rootId || node.parentId === null) return undefined;
  return layoutById.get(node.parentId);
}

function requiredBlock(blockById: ReadonlyMap<string, DisplayBlock>, id: string): DisplayBlock {
  const block = blockById.get(id);
  if (block === undefined) throw new Error(`Compound layout returned an unknown block: ${id}`);
  return block;
}

function withParent<T extends CompoundGraphNode>(node: T, parent: CompoundLayoutNode | undefined): T {
  if (parent === undefined) return node;
  return { ...node, parentId: parent.id, extent: "parent" };
}

function formatCoordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
