import { memo } from "react";
import { ChevronRight, CircleAlert, Layers3, StickyNote } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { BlockDiff } from "../commit-diff.js";
import type { DisplayBlock } from "../model.js";
import { isContextMenuKey } from "../NoteContextMenu.js";

export interface BlockNodeData extends Record<string, unknown> {
  readonly block: DisplayBlock;
  readonly dimmed: boolean;
  readonly highlighted: boolean;
  readonly onHover: (id: string | null) => void;
  readonly onActivate: (block: DisplayBlock) => void;
  readonly hasNote?: boolean;
  readonly noteText?: string;
  readonly onOpenNote?: (blockId: string) => void;
  /** Lines the selected commit changed in or under this block. */
  readonly change?: BlockDiff;
  readonly onContextMenu?: (block: DisplayBlock, x: number, y: number) => void;
}

export type MapNode = Node<BlockNodeData, "codeBlock">;

function shortPath(sourcePath: string | null): string {
  if (sourcePath === null) return "source path unresolved";
  const parts = sourcePath.split("/");
  return parts.slice(-2).join("/");
}

/** First lines of a note for a hover preview. */
export function notePreview(text: string, limit = 280): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
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
  const folder = block.id.startsWith("dir:");
  const kind = folder ? "FOLDER" : block.annotationKind;
  const activate = () => data.onActivate(block);
  return (
    <div
      className={`block-node node-${folder ? "folder" : block.annotationKind.toLowerCase()} status-${block.status}${selected ? " selected" : ""}${data.dimmed ? " dimmed" : ""}${data.highlighted ? " highlighted" : ""}${block.annotationState === "changed" ? " annotation-changed" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${block.label}, ${kind}${data.hasNote === true ? ", has note" : ""}`}
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
        <span className="node-kind">{kind}</span>
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
        {data.change !== undefined && (
          <span
            className={`node-diff${data.change.direct ? "" : " node-diff-inside"}`}
            title={data.change.direct ? "Lines this commit changed" : "Lines this commit changed inside this block"}
          >
            <span className="diff-added">+{data.change.added}</span> <span className="diff-removed">−{data.change.removed}</span>
          </span>
        )}
        {data.hasNote === true && (
          <button
            className="node-note-badge nodrag nopan"
            type="button"
            title={data.noteText === undefined ? "Open project note" : `Note: ${notePreview(data.noteText)}`}
            aria-label={`Open the project note for ${block.label}`}
            onClick={(event) => {
              event.stopPropagation();
              data.onOpenNote?.(block.id);
            }}
          >
            <StickyNote size={12} />
          </button>
        )}
        {block.annotationState === "changed" && <CircleAlert size={13} className="node-alert" />}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

export default memo(BlockNodeView);
