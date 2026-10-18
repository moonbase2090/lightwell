import ELK from "elkjs/lib/elk.bundled.js";
import type { BlockDiff } from "../commit-diff.js";
import type { ConnectionChangeState } from "../map-source.js";
import { MarkerType, type Edge } from "@xyflow/react";
import type { FactConnection, DisplayBlock } from "../model.js";
import { edgeLabelFontSize } from "../type-scale.js";
import type { MapNode, BlockNodeData } from "./BlockNode.js";

const elk = new ELK();
const nodeWidth = 222;
const nodeHeight = 94;

export async function layoutBlocks(args: {
  readonly blocks: readonly DisplayBlock[];
  readonly connections: readonly FactConnection[];
  /** Scale for connection labels. Defaults to the readable size at 1. */
  readonly labelScale?: number;
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
      labelStyle: { fill: "#a6b4c8", fontSize: edgeLabelFontSize(args.labelScale ?? 1), fontWeight: 600 },
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
  /** Note text by block id, for the card badge preview. */
  readonly noteTextById?: ReadonlyMap<string, string>;
  readonly onOpenNote?: (blockId: string) => void;
  readonly onContextMenu?: (block: DisplayBlock, x: number, y: number) => void;
  /** A commit's changed blocks and their ancestors. Everything else dims while no block is hovered. */
  readonly changes?: ReadonlyMap<string, BlockDiff>;
  readonly connectionChanges?: ReadonlyMap<string, ConnectionChangeState>;
}): { readonly nodes: MapNode[]; readonly edges: Edge[] } {
  const changedIds = args.changes === undefined ? null : new Set(args.changes.keys());
  const directNeighbors = args.activeNodeId === null
    ? new Set<string>()
    : new Set([
      args.activeNodeId,
      ...args.edges.filter((edge) => edge.source === args.activeNodeId || edge.target === args.activeNodeId)
        .flatMap((edge) => [edge.source, edge.target]),
    ]);
  const highlightedIds = args.activeFeatureMemberIds ?? (args.activeNodeId === null ? changedIds : directNeighbors);
  const nodes = args.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      dimmed: highlightedIds !== null && !highlightedIds.has(node.id),
      highlighted: highlightedIds?.has(node.id) ?? false,
      onHover: args.onHover,
      onActivate: args.onActivate,
      hasNote: args.notedBlockIds?.has(node.id) ?? false,
      ...(args.noteTextById?.has(node.id) === true ? { noteText: args.noteTextById.get(node.id) } : {}),
      ...(args.onOpenNote === undefined ? {} : { onOpenNote: args.onOpenNote }),
      ...(args.changes?.has(node.id) === true ? { change: args.changes.get(node.id) } : {}),
      ...(args.onContextMenu === undefined ? {} : { onContextMenu: args.onContextMenu }),
    },
  }));
  const edges = args.edges.map((edge) => {
    const source = typeof edge.source === "string" ? edge.source : "";
    const target = typeof edge.target === "string" ? edge.target : "";
    const connectionChange = args.connectionChanges?.get(edge.id);
    const highlighted = highlightedIds === null
      || (args.activeNodeId !== null && (source === args.activeNodeId || target === args.activeNodeId))
      || (args.activeFeatureMemberIds !== null && args.activeFeatureMemberIds.has(source) && args.activeFeatureMemberIds.has(target))
      || (highlightedIds === changedIds && changedIds !== null && changedIds.has(source) && changedIds.has(target))
      || connectionChange === "added"
      || connectionChange === "changed"
      || connectionChange === "removed";
    const color = connectionChange === "removed"
      ? "#e07070"
      : connectionChange === "added" || connectionChange === "changed"
        ? (source.startsWith("crate:") && target.startsWith("crate:") ? "#7ef0d8" : "#7ab0ff")
        : source.startsWith("crate:") && target.startsWith("crate:") ? "#59d8c0" : "#4d8df4";
    return {
      ...edge,
      animated: highlighted && highlightedIds !== null && connectionChange !== "removed",
      style: {
        ...edge.style,
        stroke: color,
        strokeWidth: highlighted ? 1.8 : 1,
        opacity: highlighted ? 0.86 : 0.09,
        ...(connectionChange === "removed" ? { strokeDasharray: "5 4" } : {}),
      },
    };
  });
  return { nodes, edges };
}
