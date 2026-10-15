import { memo } from "react";
import { ChevronRight, CircleAlert, Layers3, StickyNote } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { DisplayBlock } from "../model.js";
import { isContextMenuKey } from "../NoteContextMenu.js";

export interface BlockNodeData extends Record<string, unknown> {
  readonly block: DisplayBlock;
  readonly dimmed: boolean;
  readonly highlighted: boolean;
  readonly onHover: (id: string | null) => void;
  readonly onActivate: (block: DisplayBlock) => void;
  readonly hasNote?: boolean;
  readonly onContextMenu?: (block: DisplayBlock, x: number, y: number) => void;
}

export type MapNode = Node<BlockNodeData, "codeBlock">;

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

function BlockNodeView({ data, selected }: NodeProps<MapNode>) {
  const { block } = data;
  const activate = () => data.onActivate(block);
  return (
    <div
      className={`block-node node-${block.annotationKind.toLowerCase()} status-${block.status}${selected ? " selected" : ""}${data.dimmed ? " dimmed" : ""}${data.highlighted ? " highlighted" : ""}${block.annotationState === "changed" ? " annotation-changed" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${block.label}, ${block.annotationKind}${data.hasNote === true ? ", has note" : ""}`}
      aria-haspopup={data.onContextMenu === undefined ? undefined : "menu"}
      onMouseEnter={() => data.onHover(block.id)}
      onMouseLeave={() => data.onHover(null)}
      onContextMenu={data.onContextMenu === undefined ? undefined : (event) => {
        event.preventDefault();
        event.stopPropagation();
        data.onContextMenu?.(block, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (data.onContextMenu !== undefined && isContextMenuKey(event)) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          data.onContextMenu(block, rect.left + 12, rect.bottom - 6);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      title={block.description}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="node-topline">
        <span className="node-kind">{block.annotationKind}</span>
        {/* Unannotated blocks default to wip in the model; show no status for them. */}
        {block.annotationState !== "missing" && <span className={`status-pill status-${block.status}`}>{statusLabel(block.status)}</span>}
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
        {data.hasNote === true && <span className="node-note-badge" title="Has a project note"><StickyNote size={12} /></span>}
        {block.annotationState === "changed" && <CircleAlert size={13} className="node-alert" />}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export default memo(BlockNodeView);
