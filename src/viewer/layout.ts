import ELK from "elkjs/lib/elk.bundled.js";
import { MarkerType, type Edge } from "@xyflow/react";
import type { FactConnection, DisplayBlock } from "../model.js";
import type { MapNode, BlockNodeData } from "./BlockNode.js";

const elk = new ELK();
const nodeWidth = 222;
const nodeHeight = 94;

export async function layoutBlocks(args: {
  readonly blocks: readonly DisplayBlock[];
  readonly connections: readonly FactConnection[];
}): Promise<{ readonly nodes: MapNode[]; readonly edges: Edge[] }> {
  const visibleIds = new Set(args.blocks.map((block) => block.id));
  const connections = args.connections.filter((connection) => visibleIds.has(connection.source) && visibleIds.has(connection.target));
  const layout = await elk.layout({
    id: "lightwell",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "SPLINES",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "28",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: args.blocks.map((block) => ({ id: block.id, width: nodeWidth, height: nodeHeight })),
    edges: connections.map((connection) => ({
      id: connection.id,
      sources: [connection.source],
      targets: [connection.target],
    })),
  });
  const positions = new Map((layout.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]));
  const nodes: MapNode[] = args.blocks.map((block) => {
    const position = positions.get(block.id) ?? { x: 0, y: 0 };
    const data: BlockNodeData = {
      block,
      dimmed: false,
      highlighted: false,
      onHover: () => undefined,
      onActivate: () => undefined,
    };
    return { id: block.id, type: "codeBlock", position, width: nodeWidth, height: nodeHeight, data };
  });
  const edges: Edge[] = connections.map((connection) => {
    const color = connection.kind === "depends_on" ? "#59d8c0" : "#4d8df4";
    return {
      id: connection.id,
      source: connection.source,
      target: connection.target,
      type: "smoothstep",
      animated: false,
      label: connection.kind === "depends_on" ? "depends" : undefined,
      labelStyle: { fill: "#a6b4c8", fontSize: 9, fontWeight: 600 },
      labelBgStyle: { fill: "#111922", fillOpacity: 0.92 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      interactionWidth: 16,
      style: { stroke: color, strokeWidth: 1.2, opacity: 0.34 },
    };
  });
  return { nodes, edges };
}

export function emphasizeGraph(args: {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly Edge[];
  readonly activeNodeId: string | null;
  readonly activeFeatureMemberIds: ReadonlySet<string> | null;
  readonly onHover: (id: string | null) => void;
  readonly onActivate: (block: DisplayBlock) => void;
  readonly notedBlockIds?: ReadonlySet<string>;
  readonly onContextMenu?: (block: DisplayBlock, x: number, y: number) => void;
}): { readonly nodes: MapNode[]; readonly edges: Edge[] } {
  const directNeighbors = args.activeNodeId === null
    ? new Set<string>()
    : new Set([
      args.activeNodeId,
      ...args.edges.filter((edge) => edge.source === args.activeNodeId || edge.target === args.activeNodeId)
        .flatMap((edge) => [edge.source, edge.target]),
    ]);
  const highlightedIds = args.activeFeatureMemberIds ?? (args.activeNodeId === null ? null : directNeighbors);
  const nodes = args.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      dimmed: highlightedIds !== null && !highlightedIds.has(node.id),
      highlighted: highlightedIds?.has(node.id) ?? false,
      onHover: args.onHover,
      onActivate: args.onActivate,
      hasNote: args.notedBlockIds?.has(node.id) ?? false,
      ...(args.onContextMenu === undefined ? {} : { onContextMenu: args.onContextMenu }),
    },
  }));
  const edges = args.edges.map((edge) => {
    const source = typeof edge.source === "string" ? edge.source : "";
    const target = typeof edge.target === "string" ? edge.target : "";
    const highlighted = highlightedIds === null
      || (args.activeNodeId !== null && (source === args.activeNodeId || target === args.activeNodeId))
      || (args.activeFeatureMemberIds !== null && args.activeFeatureMemberIds.has(source) && args.activeFeatureMemberIds.has(target));
    const color = source.startsWith("crate:") && target.startsWith("crate:") ? "#59d8c0" : "#4d8df4";
    return {
      ...edge,
      animated: highlighted && highlightedIds !== null,
      style: {
        ...edge.style,
        stroke: color,
        strokeWidth: highlighted ? 1.8 : 1,
        opacity: highlighted ? 0.86 : 0.09,
      },
    };
  });
  return { nodes, edges };
}
