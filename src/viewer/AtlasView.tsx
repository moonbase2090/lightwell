import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Focus, Search, X } from "lucide-react";
import { revealExpanded, type FileTree, type FileTreeNode } from "../file-tree.js";
import type { DisplayBlock, FactConnection } from "../model.js";
import { buildAtlasLens } from "./atlas-lens.js";
import { layoutAtlas, type AtlasCell, type AtlasRect } from "./atlas-layout.js";

interface OutlineRow {
  readonly node: FileTreeNode;
  readonly level: number;
  readonly position: number;
  readonly setSize: number;
}

export function matchingOutline(
  tree: FileTree,
  expanded: ReadonlySet<string>,
  query: string,
  changedIds?: ReadonlySet<string>,
): readonly OutlineRow[] {
  const term = query.trim().toLocaleLowerCase();
  const visible = new Set<string>();
  if (term.length > 0) {
    for (const node of tree.nodes) {
      if (!`${node.label} ${node.sourcePath ?? ""}`.toLocaleLowerCase().includes(term)) continue;
      let current: FileTreeNode | undefined = node;
      while (current !== undefined && !visible.has(current.id)) {
        visible.add(current.id);
        current = current.parentId === null ? undefined : tree.nodeById.get(current.parentId);
      }
    }
  }
  const rows: OutlineRow[] = [];
  const visit = (node: FileTreeNode, level: number, seen: Set<string>) => {
    if (seen.has(node.id) || (term.length > 0 && !visible.has(node.id)) || (changedIds !== undefined && !changedIds.has(node.id))) return;
    seen.add(node.id);
    const siblings = node.parentId === null ? [node.id] : tree.nodeById.get(node.parentId)?.children ?? [node.id];
    rows.push({ node, level, position: Math.max(1, siblings.indexOf(node.id) + 1), setSize: siblings.length });
    if (term.length === 0 && changedIds === undefined && !expanded.has(node.id)) return;
    for (const childId of node.children) {
      const child = tree.nodeById.get(childId);
      if (child !== undefined) visit(child, level + 1, seen);
    }
  };
  const root = tree.nodeById.get(tree.rootId);
  if (root !== undefined) visit(root, 1, new Set());
  return rows;
}

function cellCenter(cell: AtlasCell): readonly [number, number] {
  return [cell.x + cell.width / 2, cell.y + cell.height / 2];
}

function relationPath(source: AtlasCell, target: AtlasCell): string {
  const [x1, y1] = cellCenter(source);
  const [x2, y2] = cellCenter(target);
  const bend = Math.max(20, Math.abs(x2 - x1) * 0.35);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function useElementSize(): readonly [RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 650 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => setSize({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size.width, size.height];
}

function framedRect(rect: AtlasRect | undefined, width: number, height: number): AtlasRect {
  if (rect === undefined) return { x: 0, y: 0, width, height };
  const pad = Math.max(8, Math.min(rect.width, rect.height) * 0.04);
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
}

/** Search-first atlas: exact outline for navigation, stable treemap for orientation, edges only on focus. */
export default function AtlasView({
  tree,
  blockById,
  connections,
  selectedId,
  onSelect,
  onContextMenu,
  changes,
  onlyChanged,
}: {
  readonly tree: FileTree;
  readonly blockById: ReadonlyMap<string, DisplayBlock>;
  readonly connections: readonly FactConnection[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onContextMenu: (block: DisplayBlock, x: number, y: number) => void;
  readonly changes?: ReadonlyMap<string, { readonly added: number; readonly removed: number }>;
  readonly onlyChanged: boolean;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([tree.rootId]));
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [canvasRef, width, height] = useElementSize();
  const cells = useMemo(() => layoutAtlas(tree, width, height), [height, tree, width]);
  const cellById = useMemo(() => new Map(cells.map((cell) => [cell.id, cell])), [cells]);
  const cellByBlockId = useMemo(() => new Map(cells.flatMap((cell) => cell.blockId === null ? [] : [[cell.blockId, cell] as const])), [cells]);
  const frame = framedRect(zoomId === null ? undefined : cellById.get(zoomId), width, height);
  const zoomScale = zoomId === null ? 1 : Math.min(width / frame.width, height / frame.height);
  const changedIds = useMemo(() => changes === undefined ? undefined : new Set(changes.keys()), [changes]);
  const rows = useMemo(
    () => matchingOutline(tree, expanded, query, onlyChanged ? changedIds : undefined),
    [changedIds, expanded, onlyChanged, query, tree],
  );
  const selectedTreeId = selectedId !== tree.rootId && tree.nodeById.has(selectedId) ? selectedId : null;
  const lens = useMemo(() => buildAtlasLens(tree, connections, selectedTreeId), [connections, selectedTreeId, tree]);
  const selectedLabel = selectedTreeId === null ? null : tree.nodeById.get(selectedTreeId)?.label ?? null;
  useEffect(() => {
    if (selectedTreeId === null) return;
    setExpanded((current) => revealExpanded(current, tree.nodeById, selectedTreeId));
    setZoomId(null);
  }, [selectedTreeId, tree]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectNode = (node: FileTreeNode) => {
    if (node.blockId !== null) onSelect(node.blockId);
    else toggle(node.id);
  };
  const moveOutlineFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []);
    const index = items.indexOf(event.currentTarget);
    const next = event.key === "ArrowDown" ? items[index + 1]
      : event.key === "ArrowUp" ? items[index - 1]
      : event.key === "Home" ? items[0]
      : items.at(-1);
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div className="atlas-view">
      <aside className="atlas-outline" aria-label="Workspace outline">
        <div className="atlas-search">
          <label className="atlas-search-box" htmlFor="workspace-atlas-filter">
            <Search size={14} aria-hidden="true" />
            <span className="atlas-visually-hidden">Filter workspace atlas</span>
          </label>
          <input id="workspace-atlas-filter" value={query} onChange={(event) => setQuery(event.currentTarget.value)} type="search" placeholder="Find a module or file" />
          {query.length > 0 && <button type="button" aria-label="Clear atlas filter" onClick={() => setQuery("")}><X size={13} /></button>}
        </div>
        <div className="atlas-outline-summary"><span>{rows.length} visible</span><span>{tree.nodes.length} total</span></div>
        <div className="atlas-outline-tree" role="tree" aria-label="Workspace atlas outline">
          {rows.map(({ node, level, position, setSize }) => {
            const block = node.blockId === null ? undefined : blockById.get(node.blockId);
            const change = changes?.get(node.id);
            const selected = node.blockId === selectedId;
            return (
              <button
                key={node.id}
                type="button"
                role="treeitem"
                aria-level={level}
                aria-posinset={position}
                aria-setsize={setSize}
                aria-selected={selected}
                {...(node.children.length === 0 ? {} : { "aria-expanded": query.length > 0 || onlyChanged || expanded.has(node.id) })}
                className={`atlas-outline-row${selected ? " is-selected" : ""}${change === undefined ? "" : " is-changed"}`}
                style={{ paddingInlineStart: `${10 + (level - 1) * 14}px` }}
                onClick={() => selectNode(node)}
                onContextMenu={(event) => {
                  if (block === undefined) return;
                  event.preventDefault();
                  onContextMenu(block, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  if (block !== undefined && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onContextMenu(block, rect.left + 12, rect.bottom);
                    return;
                  }
                  if (event.key === "ArrowRight" && node.children.length > 0 && !expanded.has(node.id)) { event.preventDefault(); toggle(node.id); return; }
                  if (event.key === "ArrowLeft" && expanded.has(node.id)) { event.preventDefault(); toggle(node.id); return; }
                  moveOutlineFocus(event);
                }}
              >
                <span className={`atlas-outline-mark${node.folder ? " is-folder" : ""}`} />
                <span className="atlas-outline-label">{node.label}</span>
                {change !== undefined && <span className="atlas-outline-change">+{change.added} −{change.removed}</span>}
                {block !== undefined && <span className="atlas-outline-kind">{block.annotationKind}</span>}
              </button>
            );
          })}
          {rows.length === 0 && <div className="atlas-empty">No matching blocks</div>}
        </div>
        {selectedLabel !== null && (
          <section className="atlas-relations" aria-label={`Dependencies for ${selectedLabel}`}>
            <div className="atlas-relations-heading"><strong>Dependency lens</strong><button type="button" onClick={() => onSelect(tree.rootId)}>Clear</button></div>
            <div className="atlas-relation-counts"><span>{lens.incoming.length} incoming</span><span>{lens.outgoing.length} outgoing</span></div>
            {[...lens.incoming, ...lens.outgoing].map((relation) => {
              const incoming = lens.incoming.includes(relation);
              const otherId = incoming ? relation.source : relation.target;
              const other = blockById.get(otherId);
              return <button className="atlas-relation-row" type="button" key={relation.id} onClick={() => onSelect(otherId)}><span>{incoming ? "IN" : "OUT"}</span>{other?.label ?? otherId}</button>;
            })}
          </section>
        )}
      </aside>
      <div className="atlas-canvas" ref={canvasRef}>
        <div className="atlas-canvas-actions">
          <span>ATLAS</span>
          <button type="button" onClick={() => setZoomId(null)} disabled={zoomId === null}><Focus size={13} /> Fit workspace</button>
        </div>
        <svg viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid meet" aria-label="Workspace treemap">
          {cells.map((cell) => {
            const blockId = cell.blockId;
            const change = changes?.get(cell.id);
            const selected = blockId === selectedId;
            const related = lens.focusId === null || (blockId !== null && lens.relatedBlockIds.has(blockId));
            const filtered = onlyChanged && change === undefined;
            const showLabel = !filtered && cell.width * zoomScale > 52 && cell.height * zoomScale > 24;
            return (
              <g
                key={cell.id}
                className={`atlas-cell depth-${Math.min(cell.depth, 5)}${selected ? " is-selected" : ""}${related ? "" : " is-dimmed"}${change === undefined ? "" : ` is-changed${change.added > 0 ? " has-additions" : ""}${change.removed > 0 ? " has-removals" : ""}`}${filtered ? " is-filtered" : ""}`}
                onClick={() => { if (blockId !== null) onSelect(blockId); }}
                onContextMenu={(event) => {
                  const block = blockId === null ? undefined : blockById.get(blockId);
                  if (block === undefined) return;
                  event.preventDefault();
                  onContextMenu(block, event.clientX, event.clientY);
                }}
                onDoubleClick={() => setZoomId(cell.id)}
              >
                <rect x={cell.x} y={cell.y} width={cell.width} height={cell.height} rx={cell.depth === 0 ? 8 : 3} />
                {showLabel && (
                  <text
                    x={cell.x + 7 / zoomScale}
                    y={cell.y + 16 / zoomScale}
                    style={{ fontSize: `${11 / zoomScale}px` }}
                  >
                    {cell.label}
                  </text>
                )}
              </g>
            );
          })}
          <g className="atlas-edges" aria-hidden="true">
            {lens.drawn.map((relation) => {
              const source = cellByBlockId.get(relation.source);
              const target = cellByBlockId.get(relation.target);
              if (source === undefined || target === undefined) return null;
              return <path key={relation.id} d={relationPath(source, target)} />;
            })}
          </g>
        </svg>
        {lens.hiddenCount > 0 && <div className="atlas-edge-cap">{lens.hiddenCount} more relations in the outline</div>}
      </div>
    </div>
  );
}
