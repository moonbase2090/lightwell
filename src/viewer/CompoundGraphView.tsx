import { memo } from "react";
import { StickyNote } from "lucide-react";
import {
  BaseEdge,
  Handle,
  Position,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { mapTooltip } from "./BlockNode.js";
import type { CompoundLayoutStats } from "./compound-layout.js";
import type {
  CompoundGroupNode as CompoundGroupNodeType,
  CompoundSummaryNode as CompoundSummaryNodeType,
  OrthogonalEdge as OrthogonalEdgeType,
} from "./compound-graph.js";

function CompoundGroupNodeView({ data, selected }: NodeProps<CompoundGroupNodeType>) {
  const { block } = data;
  // The workspace root fills the map, so hovering anywhere inside it must not focus it or show its tooltip.
  const root = block.type === "workspace";
  return (
    <div
      className={`compound-group compound-${block.type}${selected ? " selected" : ""}${data.dimmed ? " dimmed" : ""}${data.highlighted ? " highlighted" : ""}`}
      title={root ? undefined : mapTooltip(block)}
      onMouseEnter={root ? undefined : () => data.onHover(block.id)}
      onMouseLeave={root ? undefined : () => data.onHover(null)}
      onContextMenu={data.onContextMenu === undefined ? undefined : (event) => {
        event.preventDefault();
        event.stopPropagation();
        data.onContextMenu?.(block, event.clientX, event.clientY);
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="compound-group-header">
        <span className="compound-kind">{block.type === "workspace" ? "WORKSPACE" : block.annotationKind}</span>
        <strong>{block.label}</strong>
        {data.hiddenDescendants > 0 && <span>{data.hiddenDescendants} hidden</span>}
        {data.hasNote === true && (
          <button
            className="node-note-badge nodrag nopan"
            type="button"
            title={`Open the project note for ${block.label}`}
            aria-label={`Open the project note for ${block.label}`}
            onClick={(event) => {
              event.stopPropagation();
              data.onOpenNote?.(block.id);
            }}
          >
            <StickyNote size={12} />
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function CompoundSummaryNodeView({ data, selected }: NodeProps<CompoundSummaryNodeType>) {
  return (
    <div
      className={`compound-summary${selected ? " selected" : ""}${data.dimmed ? " dimmed" : ""}`}
      title={`Open ${data.block.label} to show more blocks`}
      onMouseEnter={() => data.onHover(data.block.id)}
      onMouseLeave={() => data.onHover(null)}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <strong>+{data.hiddenDescendants}</strong>
      <span>Open group</span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function OrthogonalEdgeView({
  id,
  data,
  markerEnd,
  style,
  interactionWidth,
  label,
  labelStyle,
  labelBgStyle,
}: EdgeProps<OrthogonalEdgeType>) {
  if (data === undefined) return null;
  return (
    <BaseEdge
      id={id}
      path={data.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
      label={data.labelPosition === null ? undefined : label}
      labelX={data.labelPosition?.x}
      labelY={data.labelPosition?.y}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelBgPadding={[7, 3]}
      labelBgBorderRadius={2}
    />
  );
}

export function DependencyLegend({ stats, durationMs }: {
  readonly stats: CompoundLayoutStats;
  readonly durationMs: number;
}) {
  return (
    <aside className="dependency-legend" aria-label="Dependency chart legend">
      <span><i className="legend-workspace" />Workspace</span>
      <span><i className="legend-app" />Entry point</span>
      <span><i className="legend-crate" />Crate</span>
      <span><i className="legend-module" />Module</span>
      <span><i className="legend-feature" />Cargo feature</span>
      <span className="dependency-layout-stats">
        {stats.renderedBlocks}/{stats.inputBlocks} blocks
        {stats.omittedEdges > 0 && ` · ${stats.omittedEdges} of ${stats.inputEdges} dependencies hidden`}
        {` · ${Math.round(durationMs)} ms`}
      </span>
    </aside>
  );
}

export const CompoundGroupNode = memo(CompoundGroupNodeView);
export const CompoundSummaryNode = memo(CompoundSummaryNodeView);
export const OrthogonalEdge = memo(OrthogonalEdgeView);
