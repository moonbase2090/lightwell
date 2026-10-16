import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DisplayBlock } from "./model.js";
import {
  explorerBadge,
  explorerPathTail,
  filterExplorerRows,
  treeBreadcrumb,
  treeDepth,
  type ExplorerBadge,
  type FileTreeNode,
  type MapView,
} from "./file-tree.js";
import type { MapDepth } from "./map-depth.js";

export interface ExplorerChangeCounts {
  readonly added: number;
  readonly removed: number;
}

function badgeFor(node: FileTreeNode, block: DisplayBlock | undefined): ExplorerBadge {
  if (block === undefined) return explorerBadge({ folder: node.folder });
  const symbolKind = block.type === "module" && block.cfgAttributes.length === 1 ? block.cfgAttributes[0] : null;
  return explorerBadge({
    folder: node.folder,
    blockType: block.type,
    ...(block.type === "module" && block.language !== undefined ? { language: block.language } : {}),
    ...(symbolKind === null ? {} : { symbolKind }),
  });
}

/** Indented file tree with kind badges, paths, and expand or collapse controls. */
export default function FileExplorer({
  root,
  nodeById,
  blockById,
  expanded,
  selectedId,
  changes,
  depth,
  depthChoices,
  onDepth,
  onToggle,
  onSelect,
  onExpandAll,
  onCollapse,
  onChooseView,
}: {
  readonly root: FileTreeNode;
  readonly nodeById: ReadonlyMap<string, FileTreeNode>;
  readonly blockById: ReadonlyMap<string, DisplayBlock>;
  readonly expanded: ReadonlySet<string>;
  readonly selectedId: string;
  readonly changes?: ReadonlyMap<string, ExplorerChangeCounts>;
  readonly depth: MapDepth;
  readonly depthChoices: readonly MapDepth[];
  readonly onDepth: (depth: MapDepth) => void;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onExpandAll: () => void;
  readonly onCollapse: () => void;
  readonly onChooseView: (view: MapView) => void;
}) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(
    () => filterExplorerRows(root, nodeById, expanded, filter),
    [expanded, filter, nodeById, root],
  );
  const selectedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const selectFromKey = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(id);
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer-toolbar">
        <span className="file-explorer-title">FILE TREE</span>
        <input
          className="file-explorer-filter"
          type="search"
          value={filter}
          placeholder="Filter symbols..."
          aria-label="Filter symbols"
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <div className="map-view" role="group" aria-label="Map view">
          <button type="button" aria-pressed={false} onClick={() => onChooseView("modules")}>Modules</button>
          <button type="button" aria-pressed={true} onClick={() => onChooseView("files")}>Files</button>
        </div>
        <button type="button" className="file-explorer-command" onClick={onExpandAll}>Expand all</button>
        <button type="button" className="file-explorer-command" onClick={onCollapse}>Collapse</button>
        <label className="map-depth">
          Depth
          <select
            aria-label="Map depth"
            value={depth === "all" ? "all" : String(depth)}
            onChange={(event) => onDepth(event.target.value === "all" ? "all" : Number(event.target.value))}
          >
            {depthChoices.map((choice) => (
              <option key={String(choice)} value={choice === "all" ? "all" : String(choice)}>
                {choice === "all" ? "All" : String(choice)}
              </option>
            ))}
          </select>
        </label>
        <span className="file-explorer-count-label">{rows.length} of {nodeById.size} nodes</span>
      </div>
      <div className="file-explorer-body" role="tree" aria-label="File tree">
        {rows.map((row) => {
          const node = nodeById.get(row.id);
          if (node === undefined) return null;
          const hasChildren = node.children.length > 0;
          const open = expanded.has(node.id);
          const block = node.blockId === null ? undefined : blockById.get(node.blockId);
          const badge = badgeFor(node, block);
          const change = changes?.get(node.id);
          const selected = node.id === selectedId;
          const pathTail = explorerPathTail(node.sourcePath);
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-level={row.level}
              aria-selected={selected}
              aria-current={selected ? "true" : undefined}
              {...(hasChildren ? { "aria-expanded": open } : {})}
              className={`file-explorer-row${selected ? " selected" : ""}`}
              style={{ paddingLeft: 8 + (row.level - 1) * 16 }}
              ref={selected ? selectedRef : undefined}
              tabIndex={0}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => selectFromKey(event, node.id)}
            >
              {Array.from({ length: Math.max(0, row.level - 1) }, (_, index) => (
                <span
                  key={index}
                  className="file-explorer-guide"
                  style={{ left: 16 + index * 16 }}
                  aria-hidden="true"
                />
              ))}
              {hasChildren ? (
                <button
                  type="button"
                  className="file-explorer-twist"
                  aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(node.id);
                  }}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                <span className="file-explorer-twist file-explorer-twist-spacer" aria-hidden="true" />
              )}
              <span className={`file-badge file-badge-${badge.toLowerCase()}`}>{badge}</span>
              <span className="file-explorer-label">{node.label}</span>
              {pathTail !== null && (
                <span className="file-explorer-path">{pathTail}</span>
              )}
              {change !== undefined && (change.added > 0 || change.removed > 0) && (
                <span className="file-explorer-diff">+{change.added} −{change.removed}</span>
              )}
              {hasChildren && <span className="file-explorer-children">{node.children.length}</span>}
            </div>
          );
        })}
        {rows.length === 0 && <div className="file-explorer-empty">No matching symbols</div>}
      </div>
    </div>
  );
}

export function TreeInspector({
  node,
  nodeById,
  blockById,
  block,
  onSelect,
  onOpen,
}: {
  readonly node: FileTreeNode;
  readonly nodeById: ReadonlyMap<string, FileTreeNode>;
  readonly blockById: ReadonlyMap<string, DisplayBlock>;
  readonly block: DisplayBlock | undefined;
  readonly onSelect: (id: string) => void;
  readonly onOpen?: () => void;
}) {
  const badge = badgeFor(node, block);
  const crumbs = treeBreadcrumb(nodeById, node.id);
  const depth = treeDepth(nodeById, node.id);
  const children = node.children
    .map((id) => nodeById.get(id))
    .filter((child): child is FileTreeNode => child !== undefined);
  return (
    <aside className="details-panel tree-inspector">
      <div className="detail-kicker">INSPECTOR</div>
      <span className={`file-badge file-badge-${badge.toLowerCase()}`}>{badge}</span>
      <div className="detail-title-row"><h2>{node.label}</h2></div>
      <p className="tree-inspector-path">{node.sourcePath ?? node.label}</p>
      <div className="tree-inspector-stats">
        <div><strong>{node.children.length}</strong><span>Direct children</span></div>
        <div><strong>{depth}</strong><span>Depth</span></div>
      </div>
      {children.length > 0 && (
        <>
          <div className="detail-divider compact" />
          <div className="detail-section-label">CHILDREN <span>{children.length}</span></div>
          <div className="member-list">
            {children.map((child) => {
              const childBlock = child.blockId === null ? undefined : blockById.get(child.blockId);
              const kind = child.folder ? "folder" : childBlock?.annotationKind.toLowerCase() ?? "file";
              return (
                <button className="member-row" key={child.id} type="button" onClick={() => onSelect(child.id)}>
                  <span className={`member-type member-${kind}`} />
                  <span>{child.label}</span>
                  <ChevronRight size={13} />
                </button>
              );
            })}
          </div>
        </>
      )}
      <div className="detail-section-label">Breadcrumb</div>
      <div className="tree-inspector-crumbs">
        {crumbs.map((crumb, index) => (
          <span key={crumb.id}>
            {index > 0 && <span className="tree-inspector-sep"> / </span>}
            <button type="button" onClick={() => onSelect(crumb.id)} aria-current={crumb.id === node.id ? "true" : undefined}>
              {crumb.label}
            </button>
          </span>
        ))}
      </div>
      {onOpen !== undefined && (
        <button className="open-block-button" type="button" onClick={onOpen}>Open</button>
      )}
    </aside>
  );
}
