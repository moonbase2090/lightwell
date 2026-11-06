import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Focus, Search, X } from "lucide-react";
import { revealExpanded, type FileTree, type FileTreeNode } from "../file-tree.js";
import type { DisplayBlock, FactConnection } from "../model.js";
import { ancestorIds, atlasCellTone, buildAtlasLens } from "./atlas-lens.js";
import {
  clampFrame,
  ellipsizeLabel,
  frameCell,
  frameFocus,
  frameMatches,
  layoutAtlas,
  panRect,
  zoomAbout,
  type AtlasCell,
  type AtlasRect,
} from "./atlas-layout.js";

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

function clientToFrame(svg: SVGSVGElement, clientX: number, clientY: number, frame: AtlasRect): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  const offsetX = (rect.width - frame.width * scale) / 2;
  const offsetY = (rect.height - frame.height * scale) / 2;
  return {
    x: frame.x + (clientX - rect.left - offsetX) / scale,
    y: frame.y + (clientY - rect.top - offsetY) / scale,
  };
}

function matchIdsFor(tree: FileTree, query: string): ReadonlySet<string> | null {
  const term = query.trim().toLocaleLowerCase();
  if (term.length === 0) return null;
  const ids = new Set<string>();
  for (const node of tree.nodes) {
    if (`${node.label} ${node.sourcePath ?? ""}`.toLocaleLowerCase().includes(term)) ids.add(node.id);
  }
  return ids;
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
  labelScale = 1,
}: {
  readonly tree: FileTree;
  readonly blockById: ReadonlyMap<string, DisplayBlock>;
  readonly connections: readonly FactConnection[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onContextMenu: (block: DisplayBlock, x: number, y: number) => void;
  readonly changes?: ReadonlyMap<string, { readonly added: number; readonly removed: number }>;
  readonly onlyChanged: boolean;
  readonly labelScale?: number;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([tree.rootId]));
  const [viewFrame, setViewFrame] = useState<AtlasRect | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [canvasRef, width, height] = useElementSize();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const frameSource = useRef<"fit" | "search" | "selection" | "region" | "gesture">("fit");
  const framedQuery = useRef<string | null>(null);
  const selectionOrigin = useRef<"map" | "outline" | "external">("external");
  const dragRef = useRef<{ x: number; y: number; frame: AtlasRect; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const cells = useMemo(() => layoutAtlas(tree, width, height), [height, tree, width]);
  const cellById = useMemo(() => new Map(cells.map((cell) => [cell.id, cell])), [cells]);
  const cellByBlockId = useMemo(() => new Map(cells.flatMap((cell) => cell.blockId === null ? [] : [[cell.blockId, cell] as const])), [cells]);
  const bounds = useMemo<AtlasRect>(() => ({ x: 0, y: 0, width, height }), [height, width]);
  const frame = viewFrame ?? bounds;
  const zoomScale = Math.min(width / frame.width, height / frame.height);
  const changedIds = useMemo(() => changes === undefined ? undefined : new Set(changes.keys()), [changes]);
  const rows = useMemo(
    () => matchingOutline(tree, expanded, query, onlyChanged ? changedIds : undefined),
    [changedIds, expanded, onlyChanged, query, tree],
  );
  const selectedTreeId = selectedId !== tree.rootId && tree.nodeById.has(selectedId) ? selectedId : null;
  const lens = useMemo(() => buildAtlasLens(tree, connections, selectedTreeId), [connections, selectedTreeId, tree]);
  const ancestors = useMemo(() => ancestorIds(tree, selectedTreeId), [selectedTreeId, tree]);
  const matches = useMemo(() => matchIdsFor(tree, query), [query, tree]);
  const selectedLabel = selectedTreeId === null ? null : tree.nodeById.get(selectedTreeId)?.label ?? null;
  const listedRelations = useMemo(
    () => [...lens.incoming, ...lens.outgoing.filter((relation) => relation.kind !== "contains")],
    [lens.incoming, lens.outgoing],
  );
  const containedCount = lens.outgoing.filter((relation) => relation.kind === "contains").length;
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const viewFrameRef = useRef(viewFrame);
  viewFrameRef.current = viewFrame;

  useEffect(() => {
    const term = query.trim();
    if (framedQuery.current === term) return;
    const previous = framedQuery.current;
    framedQuery.current = term;
    if (term.length === 0) {
      if (previous !== null) {
        frameSource.current = "fit";
        viewFrameRef.current = null;
        setViewFrame(null);
      }
      return;
    }
    const matched = cellsRef.current.filter((cell) => {
      const node = tree.nodeById.get(cell.id);
      return node !== undefined && `${node.label} ${node.sourcePath ?? ""}`.toLocaleLowerCase().includes(term.toLocaleLowerCase());
    });
    const next = matched.length === 0 ? null : frameMatches(matched, boundsRef.current);
    frameSource.current = "search";
    viewFrameRef.current = next;
    setViewFrame(next);
  }, [query, tree]);

  useEffect(() => {
    if (selectedTreeId === null) return;
    setExpanded((current) => revealExpanded(current, tree.nodeById, selectedTreeId));
    const origin = selectionOrigin.current;
    selectionOrigin.current = "external";
    if (origin === "map") return;
    const cell = cellsRef.current.find((entry) => entry.id === selectedTreeId);
    if (cell === undefined) return;
    const parentId = tree.nodeById.get(selectedTreeId)?.parentId ?? null;
    const parent = parentId === null ? undefined : cellsRef.current.find((entry) => entry.id === parentId);
    const next = frameFocus(cell, boundsRef.current, parent);
    frameSource.current = "selection";
    viewFrameRef.current = next;
    setViewFrame(next);
  }, [selectedTreeId, tree]);

  useEffect(() => {
    outlineRef.current?.querySelector(".atlas-outline-row.is-selected")?.scrollIntoView({ block: "nearest" });
  }, [rows, selectedId]);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const currentBounds = boundsRef.current;
      const current = viewFrameRef.current ?? currentBounds;
      const point = clientToFrame(svg, event.clientX, event.clientY, current);
      const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
      const next = clampFrame(zoomAbout(current, factor, point.x, point.y), currentBounds);
      frameSource.current = "gesture";
      viewFrameRef.current = next;
      setViewFrame(next);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectNode = (node: FileTreeNode) => {
    if (node.blockId !== null) {
      selectionOrigin.current = "outline";
      onSelect(node.blockId);
    } else {
      toggle(node.id);
    }
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
  const onCanvasPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, frame, moved: false };
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (drag === null || svg === null) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / drag.frame.width, rect.height / drag.frame.height);
    const dx = (event.clientX - drag.x) / Math.max(scale, 0.0001);
    const dy = (event.clientY - drag.y) / Math.max(scale, 0.0001);
    if (!drag.moved && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 5) {
      drag.moved = true;
      svg.setPointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    const next = clampFrame(panRect(drag.frame, -dx, -dy), bounds);
    frameSource.current = "gesture";
    viewFrameRef.current = next;
    setViewFrame(next);
  };
  const onCanvasPointerUp = () => {
    suppressClick.current = dragRef.current?.moved === true;
    dragRef.current = null;
  };

  const fontPx = 11 * labelScale;
  return (
    <div className="atlas-view">
      <aside className="atlas-outline" aria-label="Workspace outline">
        <div className="atlas-search">
          <label className="atlas-search-box" htmlFor="workspace-atlas-filter">
            <Search size={14} aria-hidden="true" />
            <span className="atlas-visually-hidden">Filter workspace atlas</span>
          </label>
          <input
            id="workspace-atlas-filter"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            type="search"
            placeholder="Find a module or file"
          />
          {query.length > 0 && <button type="button" aria-label="Clear atlas filter" onClick={() => setQuery("")}><X size={13} /></button>}
        </div>
        <div className="atlas-outline-summary"><span>{rows.length} visible</span><span>{tree.nodes.length} total</span></div>
        <div className="atlas-outline-tree" role="tree" aria-label="Workspace atlas outline" ref={outlineRef}>
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
                  if (event.key === "Enter" && node.blockId !== null) { event.preventDefault(); selectNode(node); return; }
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
            {lens.dependsOnCount === 0 && <p className="atlas-relation-note">No depends-on links</p>}
            {listedRelations.map((relation) => {
              const incoming = relation.target === selectedTreeId || lens.focusBlockIds.has(relation.target);
              const otherId = incoming ? relation.source : relation.target;
              const other = blockById.get(otherId);
              const kindLabel = relation.kind === "contains" ? "contains" : "depends";
              return (
                <button className="atlas-relation-row" type="button" key={relation.id} onClick={() => { selectionOrigin.current = "outline"; onSelect(otherId); }}>
                  <span>{incoming ? "IN" : "OUT"}</span>
                  <span className="atlas-relation-kind">{kindLabel}</span>
                  {other?.label ?? otherId}
                </button>
              );
            })}
            {containedCount > 0 && <p className="atlas-relation-note">Contains {containedCount} {containedCount === 1 ? "block" : "blocks"}</p>}
          </section>
        )}
      </aside>
      <div className="atlas-canvas" ref={canvasRef}>
        <div className="atlas-canvas-actions">
          <span>ATLAS</span>
          <button type="button" onClick={() => { frameSource.current = "fit"; viewFrameRef.current = null; setViewFrame(null); }} disabled={viewFrame === null}><Focus size={13} /> Fit workspace</button>
        </div>
        <svg
          ref={svgRef}
          viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label="Workspace treemap"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
        >
          {cells.map((cell, index) => {
            const blockId = cell.blockId;
            const change = changes?.get(cell.id);
            const selected = blockId === selectedId;
            const related = blockId !== null && lens.relatedBlockIds.has(blockId);
            const tone = atlasCellTone(cell, {
              selected,
              focusActive: lens.focusId !== null,
              related,
              ancestor: ancestors.has(cell.id),
              searchMiss: matches !== null && !matches.has(cell.id),
            });
            const filtered = onlyChanged && change === undefined;
            const screenW = cell.width * zoomScale;
            const screenH = cell.height * zoomScale;
            const labelText = ellipsizeLabel(cell.label, Math.max(0, screenW - 8), fontPx);
            const hovered = hoveredId === cell.id;
            const showLabel = !filtered && (selected || hovered || (labelText.length > 0 && screenW >= 34 && screenH >= 15) || (cell.depth <= 2 && labelText.length > 0 && screenW >= 22 && screenH >= 13));
            const drawnLabel = showLabel ? (labelText.length > 0 ? labelText : cell.label) : "";
            const clipId = `atlas-clip-${index}`;
            const clipHeight = cell.folder ? Math.min(cell.height, 16 / zoomScale) : cell.height;
            const textWidth = Math.max(1, cell.width - 10 / zoomScale);
            return (
              <g
                key={cell.id}
                className={`atlas-cell depth-${Math.min(cell.depth, 5)}${tone === "selected" ? " is-selected" : ""}${tone === "dimmed" ? " is-dimmed" : ""}${tone === "context" ? " is-context" : ""}${matches?.has(cell.id) === true ? " is-match" : ""}${change === undefined ? "" : ` is-changed${change.added > 0 ? " has-additions" : ""}${change.removed > 0 ? " has-removals" : ""}`}${filtered ? " is-filtered" : ""}`}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  if (blockId === null) return;
                  selectionOrigin.current = "map";
                  onSelect(blockId);
                }}
                onPointerEnter={() => setHoveredId(cell.id)}
                onPointerLeave={() => setHoveredId((current) => current === cell.id ? null : current)}
                onContextMenu={(event) => {
                  const block = blockId === null ? undefined : blockById.get(blockId);
                  if (block === undefined) return;
                  event.preventDefault();
                  onContextMenu(block, event.clientX, event.clientY);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const next = frameCell(cell, bounds);
                  frameSource.current = "region";
                  viewFrameRef.current = next;
                  setViewFrame(next);
                }}
              >
                <clipPath id={clipId}>
                  <rect x={cell.x} y={cell.y} width={Math.max(0, cell.width)} height={Math.max(0, clipHeight)} />
                </clipPath>
                <rect className="atlas-cell-shape" x={cell.x} y={cell.y} width={cell.width} height={cell.height} rx={cell.depth === 0 ? 8 : 3} />
                {drawnLabel.length > 0 && (
                  <text
                    x={cell.x + 5 / zoomScale}
                    y={cell.y + Math.min(clipHeight - 3 / zoomScale, 13 / zoomScale)}
                    clipPath={`url(#${clipId})`}
                    textLength={drawnLabel === cell.label ? undefined : textWidth}
                    lengthAdjust={drawnLabel === cell.label ? undefined : "spacingAndGlyphs"}
                    style={{ fontSize: `${fontPx / zoomScale}px` }}
                  >
                    {drawnLabel}
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
        {matches !== null && matches.size === 0 && <div className="atlas-canvas-note">No matching blocks</div>}
        {lens.hiddenCount > 0 && <div className="atlas-edge-cap">{lens.hiddenCount} more relations in the outline</div>}
      </div>
    </div>
  );
}
