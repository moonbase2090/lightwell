import { memo } from "react";
import { ChevronRight, CircleAlert, Layers3 } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { DisplayBlock } from "../model.js";

export interface BlockNodeData extends Record<string, unknown> {
  readonly block: DisplayBlock;
  readonly dimmed: boolean;
  readonly highlighted: boolean;
  readonly onHover: (id: string | null) => void;
}

export type CodeMapNode = Node<BlockNodeData, "codeBlock">;

function shortPath(sourcePath: string | null): string {
  if (sourcePath === null) return "source path unresolved";
  const parts = sourcePath.split("/");
  return parts.slice(-2).join("/");
}

function statusLabel(status: DisplayBlock["status"]): string {
  switch (status) {
    case "ready": return "ready";
    case "wip": return "wip";
    case "deprecated": return "deprecated";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function BlockNodeView({ data, selected }: NodeProps<CodeMapNode>) {
  const { block } = data;
  return (
    <div
      className={`block-node node-${block.annotationKind.toLowerCase()} status-${block.status}${selected ? " selected" : ""}${data.dimmed ? " dimmed" : ""}${data.highlighted ? " highlighted" : ""}${block.annotationState === "changed" ? " annotation-changed" : ""}`}
      onMouseEnter={() => data.onHover(block.id)}
      onMouseLeave={() => data.onHover(null)}
      title={block.description}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="node-topline">
        <span className="node-kind">{block.annotationKind}</span>
        <span className={`status-pill status-${block.status}`}>{statusLabel(block.status)}</span>
      </div>
      <div className="node-name-row">
        <span className="node-icon"><Layers3 size={14} strokeWidth={1.8} /></span>
        <span className="node-name">{block.label}</span>
      </div>
      <div className="node-bottomline">
        <span className="node-path">{shortPath(block.sourcePath)}</span>
        {block.children.length > 0 && (
          <span className="node-children"><span>{block.children.length}</span><ChevronRight size={13} /></span>
        )}
        {block.annotationState === "changed" && <CircleAlert size={13} className="node-alert" />}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export default memo(BlockNodeView);
