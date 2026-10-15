import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  FileCode2,
  FileText,
  FolderOpen,
  GitBranch,
  Layers3,
  Search,
  Settings2,
  StickyNote,
  GitCommitHorizontal,
  Waypoints,
} from "lucide-react";
import {
  Background,
  Controls,
  ReactFlow,
  useReactFlow,
  type Viewport,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { MapSource, MapSourceDocument, MapSourceEntry, ProjectNoteView, ProjectNotesSnapshot } from "./map-source.js";
import EditorSettingsPanel from "./EditorSettingsPanel.js";
import SourceInspectorPanel, { type DiffInspectionState, type SourceInspectionState } from "./SourceInspectorPanel.js";
import type { AnnotationOverlay, DisplayBlock, DisplayFeature, DisplayNode, FactConnection, ResolvedMap } from "./model.js";
import { parseAnnotationOverlay, parseFactMap, resolveMap } from "./schema.js";
import { rollUpChanges, unmappedFiles, type BlockDiff } from "./commit-diff.js";
import type { CommitChanges, CommitSummary } from "./map-source.js";
import { readThemePreference, resolveTheme, saveThemePreference, type ThemePreference } from "./theme.js";
import { readWordWrapPreference, readWordWrapShortcut, saveWordWrapPreference, saveWordWrapShortcut } from "./source-view-preferences.js";
import ProjectNotesDialog from "./ProjectNotesDialog.js";
import NoteContextMenu, {
  addNoteShortcut,
  isAddNoteShortcut,
  isContextMenuKey,
  noteMenuItems,
  type NoteMenuAction,
  type NoteMenuTarget,
} from "./NoteContextMenu.js";
import Splitter from "./Splitter.js";
import BlockNodeView, { type MapNode } from "./viewer/BlockNode.js";
import { emphasizeGraph, layoutBlocks } from "./viewer/layout.js";
import {
  DEFAULT_MAP_DEPTH,
  blocksWithinDepth,
  depthOptions,
  readMapDepth,
  subtreeDepth,
  writeMapDepth,
  type MapDepth,
  type MapDepthStorage,
} from "./map-depth.js";
import {
  buildFileTree,
  fileScopeCrumbs,
  fileScopeForBlock,
  fileTreeContainsEdges,
  fileTreeDisplayBlock,
  folderNodeId,
  folderPathFromId,
  readMapView,
  rollupAlongParents,
  scopeDirectory,
  writeMapView,
  type MapView,
} from "./file-tree.js";

const nodeTypes = { codeBlock: BlockNodeView };
const featureColors = ["#88a8ff", "#5ed7c0", "#d19af5", "#efba78", "#80c7f2", "#f08db4", "#a8d989", "#e4cf73"];
const emptyProjectNotes: ProjectNotesSnapshot = { kind: "ready", notes: [] };

type MapCatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly entries: readonly MapSourceEntry[] }
  | { readonly kind: "error"; readonly message: string };

type LoadedMapState =
  | { readonly kind: "loading"; readonly id: string | null }
  | {
      readonly kind: "ready";
      readonly id: string;
      readonly map: ResolvedMap;
      readonly projectNotes: ProjectNotesSnapshot;
    }
  | { readonly kind: "error"; readonly id: string; readonly message: string };

interface ConnectorPath {
  readonly d: string;
  readonly color: string;
}

function labelType(node: DisplayNode): string {
  return node.annotationKind.toLowerCase();
}

function childCount(block: DisplayBlock): number {
  return block.children.length;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (typeof error === "object" && error !== null && "message" in error
    && typeof error.message === "string" && error.message.length > 0) return error.message;
  return fallback;
}

function pathLabel(block: DisplayBlock): string {
  switch (block.type) {
    case "workspace": return "Cargo workspace";
    case "crate": return block.sourcePath ?? "Cargo package";
    case "app": return block.entryPath;
    case "module": return block.sourcePath ?? block.declaredByPath;
    case "cargo_feature": return `${block.packageName} · Cargo feature`;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function kindLabel(block: DisplayBlock): string {
  switch (block.type) {
    case "workspace": return "workspace root";
    case "crate": return "Cargo crate";
    case "app": return "binary entry point";
    case "module": return "Rust module";
    case "cargo_feature": return "Cargo feature";
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function formatStatus(status: DisplayNode["status"]): string {
  switch (status) {
    case "ready": return "ready";
    case "wip": return "in progress";
    case "deprecated": return "deprecated";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function mapDepthStorage(): MapDepthStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function displayConnections(scopeId: string, blocks: readonly DisplayBlock[], connections: readonly FactConnection[]) {
  const ids = new Set(blocks.map((block) => block.id));
  const relevant = connections.filter((connection) => ids.has(connection.source) && ids.has(connection.target));
  return {
    relevant,
    contains: relevant.filter((connection) => connection.kind === "contains").length,
    depends: relevant.filter((connection) => connection.kind === "depends_on").length,
    scopeId,
  };
}

function MapSourceState({
  message,
  title,
  openWorkspace,
  opening,
  error = false,
}: {
  readonly message: string;
  readonly title: string;
  readonly openWorkspace?: () => void;
  readonly opening?: boolean;
  readonly error?: boolean;
}) {
  const Icon = error ? CircleAlert : Activity;
  return (
    <div className="source-state">
      <section className="source-state-card">
        <div className="workspace-glyph"><FolderOpen size={18} /></div>
        <h1>{title}</h1>
        <p role={error ? "alert" : undefined}>{message}</p>
        {openWorkspace !== undefined && (
          <button className="open-workspace-primary" type="button" onClick={openWorkspace} disabled={opening}>
            {opening ? <Activity size={15} /> : <FolderOpen size={15} />}
            {opening ? "Opening workspace…" : "Choose Rust workspace"}
          </button>
        )}
        {openWorkspace === undefined && <Icon className="source-state-status" size={15} />}
      </section>
    </div>
  );
}

function SearchResults({
  query,
  nodes,
  onChoose,
}: {
  readonly query: string;
  readonly nodes: readonly DisplayNode[];
  readonly onChoose: (node: DisplayNode) => void;
}) {
  if (query.trim().length === 0) return null;
  const term = query.trim().toLocaleLowerCase();
  const matches = nodes
    .filter((node) => `${node.label} ${node.description} ${node.virtual ? node.pathLabel : node.sourcePath ?? ""}`.toLocaleLowerCase().includes(term))
    .slice(0, 8);
  return (
    <div className="search-results" role="listbox" aria-label="Map search results">
      {matches.length === 0 ? <div className="search-empty">No matching blocks</div> : matches.map((node) => (
        <button className="search-result" key={node.id} type="button" onClick={() => onChoose(node)}>
          <span className={`result-mark result-${labelType(node)}`} />
          <span className="result-copy">
            <span className="result-title">{node.label}</span>
            <span className="result-path">{node.virtual ? node.pathLabel : node.sourcePath ?? "workspace"}</span>
          </span>
          {node.annotationState !== "missing" && <span className={`result-status status-${node.status}`}>{node.status}</span>}
        </button>
      ))}
    </div>
  );
}

function noteButtonLabel(hasNote: boolean): "Add note" | "Edit note" {
  return hasNote ? "Edit note" : "Add note";
}

/** A block's saved project note, shown with the block it belongs to. */
function BlockNoteCard({ note, onEdit }: { readonly note: ProjectNoteView; readonly onEdit?: () => void }) {
  return (
    <section className="block-note-card" aria-label="Project note">
      <div className="block-note-header">
        <span><StickyNote size={12} /> PROJECT NOTE</span>
        {onEdit !== undefined && <button type="button" className="block-note-edit" onClick={onEdit}>Edit</button>}
      </div>
      <p className="block-note-text">{note.text}</p>
      {note.stale && <div className="block-note-stale"><CircleAlert size={12} /> Code changed since this note was written.</div>}
    </section>
  );
}

function DetailsPanel({
  node,
  map,
  onOpen,
  onSelectBlock,
  noteAction,
  onAddNote,
  note,
  onBlockContextMenu,
}: {
  readonly node: DisplayNode;
  readonly map: ResolvedMap;
  readonly onOpen: (node: DisplayNode) => void;
  readonly onSelectBlock: (id: string) => void;
  /** Note button label for this block, or undefined when notes are unavailable. */
  readonly noteAction?: "Add note" | "Edit note";
  readonly onAddNote?: () => void;
  /** The saved project note for this block, shown above the stats. */
  readonly note?: ProjectNoteView;
  readonly onBlockContextMenu?: (block: DisplayBlock, x: number, y: number) => void;
}) {
  const rowMenuProps = (block: DisplayBlock) => onBlockContextMenu === undefined ? {} : {
    "aria-haspopup": "menu" as const,
    onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onBlockContextMenu(block, event.clientX, event.clientY);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onBlockContextMenu(block, rect.left + 12, rect.bottom);
    },
  };
  if (node.virtual) {
    const members = node.memberIds.map((id) => map.blockById.get(id)).filter((block): block is DisplayBlock => block !== undefined);
    return (
      <aside className="details-panel">
        <div className="detail-kicker"><span className="kind-dot feature-dot" /> FEATURE GROUP</div>
        <div className="detail-title-row"><h2>{node.label}</h2>{node.annotationState !== "missing" && <span className={`status-pill status-${node.status}`}>{formatStatus(node.status)}</span>}</div>
        <p className="detail-description">{node.description}</p>
        {node.annotationState === "changed" && <div className="stale-note"><CircleAlert size={14} /> Source changed since this note was written.</div>}
        <div className="detail-divider" />
        <div className="detail-section-label">CONNECTED BLOCKS <span>{members.length}</span></div>
        <div className="member-list">
          {members.map((member) => (
            <button className="member-row" key={member.id} type="button" onClick={() => { onSelectBlock(member.id); onOpen(member); }} {...rowMenuProps(member)}>
              <span className={`member-type member-${member.annotationKind.toLowerCase()}`} />
              <span>{member.label}</span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
        <div className="detail-path"><span>GROUP</span><code>{node.pathLabel}</code></div>
      </aside>
    );
  }

  const incoming = map.connections.filter((connection) => connection.target === node.id).length;
  const outgoing = map.connections.filter((connection) => connection.source === node.id).length;
  const children = node.children.map((id) => map.blockById.get(id)).filter((block): block is DisplayBlock => block !== undefined);
  const changedBlocks = node.annotationState === "changed" ? 1 : 0;
  return (
    <aside className="details-panel">
      <div className="detail-kicker"><span className={`kind-dot dot-${node.annotationKind.toLowerCase()}`} /> {node.annotationKind} <span className="detail-kicker-muted">/ {kindLabel(node)}</span></div>
      <div className="detail-title-row"><h2>{node.label}</h2>{node.annotationState !== "missing" && <span className={`status-pill status-${node.status}`}>{formatStatus(node.status)}</span>}</div>
      <p className="detail-description">{node.description}</p>
      {node.annotationState === "changed" && <div className="stale-note"><CircleAlert size={14} /> Code changed since this note was written.</div>}
      {node.annotationState === "missing" && <div className="stale-note"><CircleAlert size={14} /> Add a description to the annotation overlay.</div>}
      {noteAction !== undefined && onAddNote !== undefined && (
        <button
          className="details-add-note"
          type="button"
          onClick={onAddNote}
          title={`${noteAction} for ${node.label} (${addNoteShortcut}). Notes are saved in .lightwell/notes.json.`}
        >
          <StickyNote size={14} /> {noteAction}<kbd>{addNoteShortcut}</kbd>
        </button>
      )}
      {note !== undefined && <BlockNoteCard note={note} {...(onAddNote === undefined ? {} : { onEdit: onAddNote })} />}

      <div className="detail-divider" />
      <div className="detail-section-label">BLOCK STATS</div>
      <div className="detail-stat-grid">
        <div><strong>{children.length}</strong><span>children</span></div>
        <div><strong>{incoming}</strong><span>incoming</span></div>
        <div><strong>{outgoing}</strong><span>outgoing</span></div>
        <div><strong>{changedBlocks}</strong><span>changed</span></div>
      </div>

      {node.type === "crate" && (
        <div className="detail-pair"><span>PACKAGE VERSION</span><code>{node.version}</code></div>
      )}
      {node.type === "app" && (
        <div className="detail-pair"><span>TARGET TYPE</span><code>{node.targetKind}</code></div>
      )}
      {node.type === "module" && node.cfgAttributes.length > 0 && (
        <div className="detail-pair"><span>COMPILE CONDITIONS</span><code>{node.cfgAttributes.join(" · ")}</code></div>
      )}
      {node.type === "module" && node.unresolved && (
        <div className="stale-note"><CircleAlert size={14} /> The declaration has no source file at its resolved path.</div>
      )}
      {node.type === "workspace" && (
        <div className="detail-pair"><span>WORKSPACE MEMBERS</span><code>{node.memberCount} crates</code></div>
      )}
      {node.type === "cargo_feature" && (
        <div className="detail-pair"><span>CARGO FEATURE</span><code>{node.featureName}</code></div>
      )}

      <div className="detail-path"><span>SOURCE</span><code>{pathLabel(node)}</code></div>
      {children.length > 0 && (
        <>
          <div className="detail-divider compact" />
          <div className="detail-section-label">CHILD BLOCKS <span>{children.length}</span></div>
          <div className="member-list">
            {children.slice(0, 7).map((child) => (
              <button className="member-row" key={child.id} type="button" onClick={() => { onSelectBlock(child.id); onOpen(child); }} {...rowMenuProps(child)}>
                <span className={`member-type member-${child.annotationKind.toLowerCase()}`} />
                <span>{child.label}</span>
                <ChevronRight size={13} />
              </button>
            ))}
            {children.length > 7 && <div className="more-children">+ {children.length - 7} more blocks</div>}
          </div>
        </>
      )}
      {children.length > 0 && <button className="open-block-button" type="button" onClick={() => onOpen(node)}><ArrowDownRight size={15} /> Open {node.type === "workspace" ? "workspace" : node.type}</button>}
    </aside>
  );
}

function FeatureFooter({
  map,
  group,
  activeFeatureId,
  selectedId,
  onGroupChange,
  onFeatureSelect,
  onFeatureHover,
}: {
  readonly map: ResolvedMap;
  readonly group: AnnotationOverlay["groups"][number] | undefined;
  readonly activeFeatureId: string | null;
  readonly selectedId: string;
  readonly onGroupChange: (id: string) => void;
  readonly onFeatureSelect: (feature: DisplayFeature) => void;
  readonly onFeatureHover: (id: string | null) => void;
}) {
  const groups = map.annotations.groups;
  const currentGroup = groups.find((item) => item.id === group?.id) ?? groups[0];
  const features = map.annotations.features.filter((feature) => currentGroup?.featureIds.includes(feature.id));
  return (
    <footer className="feature-footer">
      <div className="footer-head">
        <div className="footer-title"><Waypoints size={14} /><span>FEATURE GROUPS</span><span className="footer-count">{map.annotations.features.length}</span></div>
        <div className="group-tabs" role="tablist" aria-label="Feature groups">
          {groups.map((item) => (
            <button
              className={`group-tab${item.id === currentGroup?.id ? " active" : ""}`}
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === currentGroup?.id}
              onClick={() => onGroupChange(item.id)}
            >
              {item.label}<span>{item.featureIds.length}</span>
            </button>
          ))}
        </div>
        <span className="footer-hint">Hover a feature to trace its code</span>
      </div>
      <div className="feature-cards">
        {features.map((feature) => {
          const display = map.nodeById.get(feature.id);
          if (display === undefined || !display.virtual) return null;
          const colorIndex = map.annotations.features.findIndex((item) => item.id === feature.id);
          return (
            <button
              key={feature.id}
              type="button"
              data-feature-id={feature.id}
              className={`feature-card${feature.id === activeFeatureId ? " tracing" : ""}${feature.id === selectedId ? " chosen" : ""}${display.annotationState === "changed" ? " feature-changed" : ""} feature-color-${colorIndex % featureColors.length}`}
              onMouseEnter={() => onFeatureHover(feature.id)}
              onMouseLeave={() => onFeatureHover(null)}
              onFocus={() => onFeatureHover(feature.id)}
              onBlur={() => onFeatureHover(null)}
              onClick={() => onFeatureSelect(display)}
            >
              <span className="feature-type">FEATURE <i className={`status-mark status-${feature.status}`} /></span>
              <span className="feature-title">{feature.label}</span>
              <span className="feature-meta"><span>{feature.memberIds.length} blocks</span><ArrowRight size={13} /></span>
            </button>
          );
        })}
        {features.length === 0 && <div className="feature-empty">No feature notes in this group.</div>}
      </div>
    </footer>
  );
}

const GRAPH_FIT_OPTIONS = { padding: 0.2, minZoom: 0.18, maxZoom: 1.2 } as const;

/** Children kept in view around the scope block; wide scopes pan for the rest. */
const FIT_NEAREST_CHILDREN = 8;

/**
 * Fit the scope block and its nearest children when a map first loads and after
 * each scope change. Fitting every child of a wide scope (80+ crates in one row)
 * zooms out until the cards cannot be read.
 */
/** A one-time request to center and zoom on a block, such as from Show on map. */
export interface FocusRequest {
  readonly blockId: string;
  readonly sequence: number;
}

function FitOnScopeChange({
  scopeId,
  viewKey,
  layoutRevision,
  focus,
  onFocusHandled,
}: {
  readonly scopeId: string;
  readonly viewKey: string;
  readonly layoutRevision: number;
  /** Cleared by the parent through onFocusHandled, so a remount does not repeat it. */
  readonly focus: FocusRequest | null;
  readonly onFocusHandled: () => void;
}) {
  const { fitView, getNodes } = useReactFlow();
  const previousScopeId = useRef(`${scopeId}\0${viewKey}`);
  // The first fit waits for the first finished layout (#104). Revision 0 means
  // layoutBlocks has not placed any node yet.
  const nextLayoutRevision = useRef(Math.max(layoutRevision, 1));
  const waitingForLayout = useRef(true);

  useEffect(() => {
    const fitKey = `${scopeId}\0${viewKey}`;
    if (previousScopeId.current !== fitKey) {
      previousScopeId.current = fitKey;
      nextLayoutRevision.current = layoutRevision + 1;
      waitingForLayout.current = true;
    }
    const pendingFocus = focus;
    const layoutReady = !waitingForLayout.current || layoutRevision >= nextLayoutRevision.current;
    if (pendingFocus !== null && layoutReady) {
      waitingForLayout.current = false;
      const frame = requestAnimationFrame(() => {
        // Cleared only once the fit runs: a re-render before the frame retries it.
        onFocusHandled();
        if (getNodes().some((node) => node.id === pendingFocus.blockId)) {
          void fitView({ nodes: [{ id: pendingFocus.blockId }], padding: 0.35, minZoom: 0.5, maxZoom: 1.2, duration: 250 });
        }
      });
      return () => cancelAnimationFrame(frame);
    }
    if (waitingForLayout.current && layoutRevision >= nextLayoutRevision.current) {
      waitingForLayout.current = false;
      // Wait a frame so React Flow has measured the new nodes.
      const frame = requestAnimationFrame(() => {
        const nodes = getNodes();
        const root = nodes.find((node) => node.id === scopeId);
        if (root === undefined || nodes.length <= FIT_NEAREST_CHILDREN + 1) {
          void fitView({ ...GRAPH_FIT_OPTIONS, duration: 200 });
          return;
        }
        const centerX = (node: (typeof nodes)[number]) => node.position.x + (node.measured?.width ?? 0) / 2;
        const rootX = centerX(root);
        const nearest = nodes
          .filter((node) => node.id !== root.id)
          .sort((left, right) => Math.abs(centerX(left) - rootX) - Math.abs(centerX(right) - rootX))
          .slice(0, FIT_NEAREST_CHILDREN);
        void fitView({ ...GRAPH_FIT_OPTIONS, duration: 200, nodes: [root, ...nearest].map((node) => ({ id: node.id })) });
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [fitView, focus, getNodes, layoutRevision, onFocusHandled, scopeId, viewKey]);

  return null;
}

function RestoreViewport({
  refreshVersion,
  layoutRevision,
  getSavedViewport,
}: {
  readonly refreshVersion: number;
  readonly layoutRevision: number;
  readonly getSavedViewport: () => Viewport | null;
}) {
  const { setViewport } = useReactFlow();
  const previousRefreshVersion = useRef(refreshVersion);
  const nextLayoutRevision = useRef(layoutRevision);
  const waitingForLayout = useRef(false);

  useEffect(() => {
    if (previousRefreshVersion.current !== refreshVersion) {
      previousRefreshVersion.current = refreshVersion;
      nextLayoutRevision.current = layoutRevision + 1;
      waitingForLayout.current = true;
    }
    if (waitingForLayout.current && layoutRevision >= nextLayoutRevision.current) {
      waitingForLayout.current = false;
      const viewport = getSavedViewport();
      if (viewport !== null) void setViewport(viewport, { duration: 0 });
    }
  }, [getSavedViewport, layoutRevision, refreshVersion, setViewport]);

  return null;
}

function App({ mapSource }: { readonly mapSource: MapSource }) {
  const [mapCatalog, setMapCatalog] = useState<MapCatalogState>({ kind: "loading" });
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [loadedMap, setLoadedMap] = useState<LoadedMapState>({ kind: "loading", id: null });
  const [workspaceError, setWorkspaceError] = useState("");
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [notesDialog, setNotesDialog] = useState<{ readonly blockId: string | null; readonly initialText: string } | null>(null);
  const [noteMenu, setNoteMenu] = useState<NoteMenuTarget | null>(null);
  const [noteActionError, setNoteActionError] = useState("");
  const [mapRequestVersion, setMapRequestVersion] = useState(0);
  const [mapRefreshVersion, setMapRefreshVersion] = useState(0);
  const [scopePath, setScopePath] = useState<string[]>([]);
  const [mapDepth, setMapDepth] = useState<MapDepth>(DEFAULT_MAP_DEPTH);
  const [depthWorkspaceId, setDepthWorkspaceId] = useState<string | null>(null);
  if (mapKey !== depthWorkspaceId) {
    setDepthWorkspaceId(mapKey);
    setMapDepth(mapKey === null ? DEFAULT_MAP_DEPTH : readMapDepth(mapDepthStorage(), mapKey));
  }
  const [mapView, setMapView] = useState<MapView>("modules");
  const [viewWorkspaceId, setViewWorkspaceId] = useState<string | null>(null);
  if (mapKey !== viewWorkspaceId) {
    setViewWorkspaceId(mapKey);
    setMapView(mapKey === null ? "modules" : readMapView(mapDepthStorage(), mapKey));
  }
  const [fileScope, setFileScope] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [activeGroupId, setActiveGroupId] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeFeatureId, setActiveFeatureId] = useState<string | null>(null);
  const [inspectedBlockId, setInspectedBlockId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<SourceInspectionState>({ kind: "loading" });
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorActionError, setEditorActionError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);
  const [wordWrap, setWordWrap] = useState(readWordWrapPreference);
  const [wordWrapShortcut, setWordWrapShortcut] = useState(readWordWrapShortcut);
  const changeWordWrapShortcut = useCallback((shortcut: string) => {
    saveWordWrapShortcut(shortcut);
    setWordWrapShortcut(shortcut);
  }, []);
  const toggleWordWrap = useCallback(() => {
    setWordWrap((current) => {
      saveWordWrapPreference(!current);
      return !current;
    });
  }, []);
  const [commits, setCommits] = useState<readonly CommitSummary[]>([]);
  const [selectedCommit, setSelectedCommit] = useState("");
  const [commitDiff, setCommitDiff] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "loading"; readonly commitId: string }
    | { readonly kind: "ready"; readonly changes: CommitChanges; readonly byBlock: ReadonlyMap<string, BlockDiff> }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "idle" });
  const [blockDiff, setBlockDiff] = useState<DiffInspectionState | null>(null);
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(() => (
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
  ));
  const [baseGraph, setBaseGraph] = useState<{ readonly nodes: MapNode[]; readonly edges: ReturnType<typeof emphasizeGraph>["edges"] }>({ nodes: [], edges: [] });
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [graphError, setGraphError] = useState("");
  const shellRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const savedViewportRef = useRef<Viewport | null>(null);
  const initializedMapKeyRef = useRef<string | null>(null);
  const [connectorPaths, setConnectorPaths] = useState<readonly ConnectorPath[]>([]);
  const getSavedViewport = useCallback(() => savedViewportRef.current, []);
  const theme = resolveTheme(themePreference, systemTheme);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: light)");
    const updateSystemTheme = () => setSystemTheme(preference.matches ? "light" : "dark");
    updateSystemTheme();
    if (typeof preference.addEventListener === "function") {
      preference.addEventListener("change", updateSystemTheme);
      return () => preference.removeEventListener("change", updateSystemTheme);
    }
    preference.addListener(updateSystemTheme);
    return () => preference.removeListener(updateSystemTheme);
  }, []);

  const changeTheme = useCallback((preference: ThemePreference) => {
    setThemePreference(preference);
    saveThemePreference(preference);
  }, []);

  const handleOpenWorkspace = useCallback(async () => {
    if (mapSource.openWorkspace === undefined) return;
    setWorkspaceError("");
    setOpeningWorkspace(true);
    try {
      const entry = await mapSource.openWorkspace();
      if (entry === null) return;
      setMapCatalog((current) => {
        const entries = current.kind === "ready" ? current.entries : [];
        return {
          kind: "ready",
          entries: [entry, ...entries.filter((item) => item.id !== entry.id)],
        };
      });
      setMapKey(entry.id);
      setInspectedBlockId(null);
      setMapRequestVersion((version) => version + 1);
    } catch (error: unknown) {
      setWorkspaceError(describeError(error, "Could not open this Rust workspace."));
    } finally {
      setOpeningWorkspace(false);
    }
  }, [mapSource]);

  useEffect(() => {
    let cancelled = false;
    setMapCatalog({ kind: "loading" });
    void Promise.resolve()
      .then(() => mapSource.listMaps())
      .then((entries) => {
        if (cancelled) return;
        setMapCatalog((current) => {
          const recent = current.kind === "ready" ? current.entries : [];
          return {
            kind: "ready",
            entries: [...recent, ...entries.filter((entry) => !recent.some((item) => item.id === entry.id))],
          };
        });
        setMapKey((current) => current ?? entries[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMapCatalog((current) => current.kind === "ready" ? current : {
            kind: "error",
            message: describeError(error, "Could not list available maps."),
          });
        }
      });
    return () => { cancelled = true; };
  }, [mapSource]);

  useEffect(() => {
    if (mapKey === null) {
      setLoadedMap({ kind: "loading", id: null });
      return;
    }
    let cancelled = false;
    let unwatch: (() => void) | undefined;
    setLoadedMap({ kind: "loading", id: mapKey });
    void Promise.resolve()
      .then(() => mapSource.loadMap(mapKey))
      .then((document) => {
        const map = resolveMap(
          parseFactMap(document.facts),
          parseAnnotationOverlay(document.annotations),
        );
        if (!cancelled) {
          setWorkspaceError("");
          setLoadedMap({
            kind: "ready",
            id: mapKey,
            map,
            projectNotes: document.projectNotes ?? { kind: "ready", notes: [] },
          });
          setMapCatalog((current) => current.kind === "ready"
            ? {
                kind: "ready",
                entries: current.entries.map((entry) => entry.id === mapKey
                  ? { ...entry, label: map.facts.project.name }
                  : entry),
              }
              : current);

          const acceptUpdate = (updatedDocument: MapSourceDocument) => {
            if (cancelled) return;
            try {
              const updatedMap = resolveMap(
                parseFactMap(updatedDocument.facts),
                parseAnnotationOverlay(updatedDocument.annotations),
              );
              setLoadedMap((current) => current.kind === "ready" && current.id === mapKey
                ? {
                    ...current,
                    map: updatedMap,
                    projectNotes: updatedDocument.projectNotes ?? current.projectNotes,
                  }
                : current);
              setMapCatalog((current) => current.kind === "ready"
                ? {
                    kind: "ready",
                    entries: current.entries.map((entry) => entry.id === mapKey
                      ? { ...entry, label: updatedMap.facts.project.name }
                      : entry),
                  }
                : current);
              setWorkspaceError("");
              setMapRefreshVersion((version) => version + 1);
            } catch (error: unknown) {
              setWorkspaceError(`Could not apply a live map update: ${describeError(error, "Invalid map data.")}`);
            }
          };

          const watchMap = mapSource.watchMap;
          if (watchMap !== undefined) {
            void watchMap.call(mapSource, mapKey, acceptUpdate, (error) => {
              if (!cancelled) {
                setWorkspaceError(`Live refresh failed: ${describeError(error, "The workspace watcher stopped.")}`);
              }
            }).then((cleanup) => {
              if (cancelled) cleanup();
              else unwatch = cleanup;
            }).catch((error: unknown) => {
              if (!cancelled) {
                setWorkspaceError(`Live refresh failed: ${describeError(error, "Could not watch this workspace.")}`);
              }
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadedMap({
            kind: "error",
            id: mapKey,
            message: describeError(error, "Could not load map data."),
          });
        }
      });
    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [mapSource, mapKey, mapRequestVersion]);

  const source = mapCatalog.kind === "ready"
    ? mapCatalog.entries.find((entry) => entry.id === mapKey)
    : undefined;
  const openWorkspaceAction = mapSource.openWorkspace === undefined ? undefined : handleOpenWorkspace;
  const map = loadedMap.kind === "ready" && loadedMap.id === mapKey ? loadedMap.map : null;
  const history = mapSource.history;

  useEffect(() => {
    setCommits([]);
    setSelectedCommit("");
    setCommitDiff({ kind: "idle" });
    if (history === undefined || mapKey === null) return;
    let cancelled = false;
    void history.listCommits(mapKey)
      .then((list) => { if (!cancelled) setCommits(list); })
      .catch(() => { if (!cancelled) setCommits([]); });
    return () => { cancelled = true; };
  }, [history, mapKey]);

  useEffect(() => {
    if (history === undefined || mapKey === null || map === null || selectedCommit === "") {
      setCommitDiff({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setCommitDiff({ kind: "loading", commitId: selectedCommit });
    const currentMap = map;
    void history.commitChanges(mapKey, selectedCommit)
      .then((changes) => {
        if (cancelled) return;
        const byBlock = rollUpChanges(changes, (id) => currentMap.blockById.get(id)?.parentId);
        setCommitDiff({ kind: "ready", changes, byBlock });
      })
      .catch((error: unknown) => {
        if (!cancelled) setCommitDiff({ kind: "error", message: describeError(error, "Could not read this commit.") });
      });
    return () => { cancelled = true; };
  }, [history, map, mapKey, selectedCommit]);

  // While a commit is shown, inspecting a block it changed opens that block's diff.
  const diffCommitId = commitDiff.kind === "ready" ? commitDiff.changes.commit.id : null;
  const inspectedChangedDirectly = commitDiff.kind === "ready" && inspectedBlockId !== null
    && commitDiff.changes.blocks.some((block) => block.blockId === inspectedBlockId);
  useEffect(() => {
    if (history === undefined || mapKey === null || diffCommitId === null || inspectedBlockId === null || !inspectedChangedDirectly) {
      setBlockDiff(null);
      return;
    }
    let cancelled = false;
    setBlockDiff({ kind: "loading" });
    void history.blockDiff(mapKey, diffCommitId, inspectedBlockId)
      .then((document) => { if (!cancelled) setBlockDiff({ kind: "ready", document }); })
      .catch((error: unknown) => {
        if (!cancelled) setBlockDiff({ kind: "error", message: describeError(error, "Could not load this commit diff.") });
      });
    return () => { cancelled = true; };
  }, [diffCommitId, history, inspectedBlockId, inspectedChangedDirectly, mapKey]);
  const projectNotes = loadedMap.kind === "ready" && loadedMap.id === mapKey
    ? loadedMap.projectNotes
    : emptyProjectNotes;
  const projectNotesSource = mapSource.projectNotes;
  const rootId = map?.facts.project.id ?? "";
  const validPath = map !== null && scopePath.length > 0 && scopePath[0] === rootId
    ? scopePath.filter((id) => map.blockById.has(id))
    : rootId.length > 0 ? [rootId] : [];
  const scopeId = validPath.at(-1) ?? rootId;
  const scope = map?.blockById.get(scopeId) ?? (map === null ? undefined : map.blockById.get(rootId));
  const fileScopeResetKey = `${mapKey ?? ""}:${scopeId}`;
  const fileScopeResetKeyRef = useRef(fileScopeResetKey);
  useEffect(() => {
    if (fileScopeResetKeyRef.current === fileScopeResetKey) return;
    fileScopeResetKeyRef.current = fileScopeResetKey;
    setFileScope("");
  }, [fileScopeResetKey]);
  const scopeChildren = useMemo(() => scope?.children
    .map((id) => map?.blockById.get(id))
    .filter((block): block is DisplayBlock => block !== undefined) ?? [], [map, scopeId]);
  const fileTree = useMemo(() => {
    if (map === null || scope === undefined || mapView !== "files") return null;
    return buildFileTree(scope, map.blockById);
  }, [map, mapView, scope]);
  const fileRoot = useMemo(() => {
    if (fileTree === null || scope === undefined) return undefined;
    if (fileScope === "") return fileTree.nodeById.get(scope.id);
    return fileTree.nodeById.get(folderNodeId(fileScope)) ?? fileTree.nodeById.get(scope.id);
  }, [fileScope, fileTree, scope]);
  const visibleBlocks = useMemo(() => {
    if (scope === undefined || map === null) return [];
    if (mapView === "modules" || fileTree === null || fileRoot === undefined) {
      return blocksWithinDepth(scope, mapDepth, map.blockById);
    }
    return blocksWithinDepth(fileRoot, mapDepth, fileTree.nodeById)
      .map((node) => fileTreeDisplayBlock(node, map.blockById))
      .filter((block): block is DisplayBlock => block !== null);
  }, [fileRoot, fileTree, map, mapDepth, mapView, scope]);
  const graphConnections = useMemo(() => {
    if (map === null) return [];
    if (mapView !== "files" || fileTree === null) return map.connections;
    return [
      ...fileTreeContainsEdges(fileTree),
      ...map.connections.filter((connection) => connection.kind === "depends_on"),
    ];
  }, [fileTree, map, mapView]);
  const connectionsInScope = displayConnections(scopeId, visibleBlocks, graphConnections);
  const selected = map?.nodeById.get(selectedId) ?? scope;
  const activeFeature = activeFeatureId === null ? undefined : map?.nodeById.get(activeFeatureId);
  const activeFeatureMembers = useMemo(() => activeFeature?.virtual === true ? new Set(activeFeature.memberIds) : null, [activeFeature]);
  const chosenGroup = map?.annotations.groups.find((group) => group.id === activeGroupId) ?? map?.annotations.groups[0];
  const staleCount = map?.nodes.filter((node) => node.annotationState !== "current").length ?? 0;
  const directConnectionSummary = connectionsInScope;
  const projectDescription = map?.annotations.blocks[rootId]?.description.trim() ?? "";

  const setHoverNode = useCallback((id: string | null) => {
    setActiveNodeId(id);
    if (id !== null) setActiveFeatureId(null);
  }, []);

  const closeProjectNotes = useCallback(() => setNotesDialog(null), []);
  const closeNoteMenu = useCallback(() => setNoteMenu(null), []);
  const noteByBlockId = useMemo(
    () => new Map(projectNotes.kind === "ready" ? projectNotes.notes.map((note) => [note.blockId, note] as const) : []),
    [projectNotes],
  );
  const noteTextById = useMemo(
    () => new Map([...noteByBlockId].map(([blockId, note]) => [blockId, note.text] as const)),
    [noteByBlockId],
  );
  const notedBlockIds = useMemo(
    () => new Set(projectNotes.kind === "ready" ? projectNotes.notes.map((note) => note.blockId) : []),
    [projectNotes],
  );
  const notesAvailable = projectNotesSource !== undefined && projectNotes.kind === "ready";
  const openNoteFor = useCallback((blockId: string | null, initialText = "") => {
    setNoteMenu(null);
    setNotesDialog({ blockId, initialText });
  }, []);
  const showBlockMenu = useCallback((block: DisplayBlock, x: number, y: number) => {
    setNoteActionError("");
    setNoteMenu({ blockId: block.id, x, y });
  }, []);
  const acceptProjectNotes = useCallback((snapshot: ProjectNotesSnapshot) => {
    setLoadedMap((current) => current.kind === "ready" && current.id === mapKey
      ? { ...current, projectNotes: snapshot }
      : current);
  }, [mapKey]);

  useEffect(() => {
    if (map === null || initializedMapKeyRef.current === mapKey) return;
    initializedMapKeyRef.current = mapKey;
    setScopePath([map.facts.project.id]);
    setSelectedId(map.facts.project.id);
    setSearch("");
    setActiveGroupId(map.annotations.groups[0]?.id ?? "");
    setActiveNodeId(null);
    setActiveFeatureId(null);
  }, [mapKey, map]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (map === null || scope === undefined) {
      setBaseGraph({ nodes: [], edges: [] });
      return;
    }
    setGraphError("");
    layoutBlocks({ blocks: visibleBlocks, connections: graphConnections })
      .then((graph) => {
        if (!cancelled) {
          setBaseGraph(graph);
          setLayoutRevision((revision) => revision + 1);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setGraphError(error instanceof Error ? error.message : "Graph layout failed.");
      });
    return () => { cancelled = true; };
  }, [graphConnections, map, scopeId, visibleBlocks]);

  const activateBlock = useCallback((block: DisplayBlock) => {
    const folderPath = folderPathFromId(block.id);
    if (folderPath !== null) {
      setFileScope(folderPath);
      setActiveFeatureId(null);
      setActiveNodeId(null);
      return;
    }
    setSelectedId(block.id);
    setActiveFeatureId(null);
    setActiveNodeId(null);
    if (mapView === "files") return;
    if (block.children.length > 0) setScopePath((current) => current.at(-1) === block.id ? current : [...current, block.id]);
  }, [mapView]);

  const openBlockInspector = useCallback((block: DisplayBlock) => {
    activateBlock(block);
    if (folderPathFromId(block.id) !== null) return;
    if (mapSource.editor !== undefined) {
      setInspectedBlockId(block.id);
      setEditorActionError("");
    } else {
      setInspectedBlockId(null);
    }
  }, [activateBlock, mapSource.editor]);

  const graphChanges = useMemo(() => {
    if (commitDiff.kind !== "ready") return undefined;
    if (mapView !== "files" || fileTree === null) return commitDiff.byBlock;
    const direct = new Map<string, { added: number; removed: number }>();
    for (const [id, change] of commitDiff.byBlock) {
      if (change.direct) direct.set(id, { added: change.added, removed: change.removed });
    }
    return rollupAlongParents(direct, fileTree.parentOf);
  }, [commitDiff, fileTree, mapView]);
  const graph = useMemo(() => emphasizeGraph({
    nodes: baseGraph.nodes,
    edges: baseGraph.edges,
    activeNodeId,
    activeFeatureMemberIds: activeFeatureMembers,
    onHover: setHoverNode,
    onActivate: openBlockInspector,
    notedBlockIds,
    noteTextById,
    onOpenNote: openNoteFor,
    onContextMenu: showBlockMenu,
    ...(graphChanges === undefined ? {} : { changes: graphChanges }),
  }), [baseGraph, activeNodeId, activeFeatureMembers, setHoverNode, openBlockInspector, notedBlockIds, noteTextById, openNoteFor, showBlockMenu, graphChanges]);

  const noteTargetId = inspectedBlockId ?? (map?.blockById.has(selectedId) === true ? selectedId : null);
  useEffect(() => {
    if (!notesAvailable || notesDialog !== null || noteMenu !== null || noteTargetId === null) return;
    const handleNoteShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!isAddNoteShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        targetTag: target?.tagName ?? "",
        targetEditable: target?.isContentEditable === true,
      })) return;
      event.preventDefault();
      openNoteFor(noteTargetId);
    };
    window.addEventListener("keydown", handleNoteShortcut);
    return () => window.removeEventListener("keydown", handleNoteShortcut);
  }, [notesAvailable, notesDialog, noteMenu, noteTargetId, openNoteFor]);

  const selectSearchNode = useCallback((node: DisplayNode) => {
    setSearch("");
    setActiveNodeId(null);
    if (node.virtual) {
      setInspectedBlockId(null);
      setSelectedId(node.id);
      const matchingGroup = map?.annotations.groups.find((group) => group.featureIds.includes(node.id));
      if (matchingGroup !== undefined) setActiveGroupId(matchingGroup.id);
      return;
    }
    setSelectedId(node.id);
    if (mapSource.editor !== undefined) setInspectedBlockId(node.id);
    if (map === null) return;
    const ancestors: string[] = [];
    let cursor: DisplayBlock | undefined = node;
    while (cursor !== undefined) {
      ancestors.unshift(cursor.id);
      cursor = cursor.parentId === null ? undefined : map.blockById.get(cursor.parentId);
    }
    setScopePath(ancestors.length > 1 ? ancestors.slice(0, -1) : ancestors);
    setFocusRequest((current) => ({ blockId: node.id, sequence: (current?.sequence ?? 0) + 1 }));
  }, [map, mapSource.editor]);

  const onNodeClick: NodeMouseHandler<MapNode> = useCallback((_event, node) => {
    openBlockInspector(node.data.block);
  }, [openBlockInspector]);
  const chooseMapView = useCallback((next: MapView) => {
    setMapView(next);
    if (mapKey !== null) writeMapView(mapDepthStorage(), mapKey, next);
    if (map === null || scope === undefined) return;
    const block = map.blockById.get(selectedId);
    if (next === "files") {
      setFileScope(block === undefined ? "" : fileScopeForBlock(block.sourcePath, scopeDirectory(scope.sourcePath)));
    }
    if (block !== undefined) {
      setFocusRequest((current) => ({ blockId: block.id, sequence: (current?.sequence ?? 0) + 1 }));
    }
  }, [map, mapKey, scope, selectedId]);

  useEffect(() => {
    const editor = mapSource.editor;
    if (inspectedBlockId === null || mapKey === null || editor === undefined) {
      setInspection({ kind: "loading" });
      return;
    }

    let cancelled = false;
    setInspection({ kind: "loading" });
    void editor.inspectBlock(mapKey, inspectedBlockId)
      .then((document) => {
        if (!cancelled) setInspection({ kind: "ready", document });
      })
      .catch((error: unknown) => {
        if (!cancelled) setInspection({ kind: "error", message: describeError(error, "Could not load this source file.") });
      });
    return () => { cancelled = true; };
  }, [inspectedBlockId, mapKey, mapRefreshVersion, mapSource.editor]);

  const handleOpenInEditor = useCallback(async () => {
    const editor = mapSource.editor;
    if (editor === undefined || mapKey === null || inspectedBlockId === null) return;
    setOpeningEditor(true);
    setEditorActionError("");
    try {
      await editor.openBlock(mapKey, inspectedBlockId);
    } catch (error: unknown) {
      setEditorActionError(describeError(error, "Could not open this file in your editor."));
    } finally {
      setOpeningEditor(false);
    }
  }, [inspectedBlockId, mapKey, mapSource.editor]);

  const closeSettingsPanel = useCallback(() => setSettingsOpen(false), []);

  useLayoutEffect(() => {
    if (activeFeatureId === null || shellRef.current === null || map === null) {
      setConnectorPaths([]);
      return;
    }
    const shell = shellRef.current;
    const currentMap = map;
    const animationFrame = requestAnimationFrame(() => {
      const feature = currentMap.nodeById.get(activeFeatureId);
      const featureCard = [...shell.querySelectorAll<HTMLElement>("[data-feature-id]")]
        .find((element) => element.dataset.featureId === activeFeatureId);
      if (feature?.virtual !== true || featureCard === undefined) {
        setConnectorPaths([]);
        return;
      }
      const shellRect = shell.getBoundingClientRect();
      const cardRect = featureCard.getBoundingClientRect();
      const members = new Set(feature.memberIds);
      const visibleElements = [...shell.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")]
        .filter((element) => members.has(element.getAttribute("data-id") ?? ""));
      const paths = visibleElements.map((element) => {
        const rect = element.getBoundingClientRect();
        const x1 = rect.left + rect.width / 2 - shellRect.left;
        const y1 = rect.bottom - shellRect.top;
        const x2 = cardRect.left + cardRect.width / 2 - shellRect.left;
        const y2 = cardRect.top - shellRect.top;
        const bend = Math.max(28, (y2 - y1) * 0.44);
        return { d: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`, color: featureColors[currentMap.annotations.features.findIndex((item) => item.id === activeFeatureId) % featureColors.length] };
      });
      setConnectorPaths(paths);
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [activeFeatureId, map, scopeId, baseGraph.nodes]);

  const chooseBreadcrumb = (index: number) => {
    const path = validPath.slice(0, index + 1);
    setScopePath(path);
    setFileScope("");
    setSelectedId(path.at(-1) ?? rootId);
    setActiveFeatureId(null);
    setActiveNodeId(null);
    setInspectedBlockId(null);
  };

  if (mapCatalog.kind === "loading") {
    return <MapSourceState
      title="Loading workspaces"
      message={workspaceError || "Reading recent workspaces…"}
      openWorkspace={openWorkspaceAction}
      opening={openingWorkspace}
      error={workspaceError.length > 0}
    />;
  }
  if (mapCatalog.kind === "error") {
    return <MapSourceState title="Could not load recent workspaces" message={workspaceError || mapCatalog.message} openWorkspace={openWorkspaceAction} opening={openingWorkspace} error />;
  }
  if (mapCatalog.entries.length === 0) {
    return <MapSourceState
      title="Open a Rust workspace"
      message={workspaceError || "Choose a folder with a Cargo.toml to build its local architecture map."}
      openWorkspace={openWorkspaceAction}
      opening={openingWorkspace}
      error={workspaceError.length > 0}
    />;
  }
  if (mapKey === null) {
    return <MapSourceState title="Selecting a workspace" message="Preparing the workspace map…" openWorkspace={openWorkspaceAction} opening={openingWorkspace} />;
  }
  if (source === undefined) {
    return <MapSourceState title="Workspace unavailable" message="The selected map is not available from this source." openWorkspace={openWorkspaceAction} opening={openingWorkspace} error />;
  }
  if (loadedMap.kind === "error" && loadedMap.id === mapKey) {
    return <MapSourceState title="Could not open this Rust workspace" message={loadedMap.message} openWorkspace={openWorkspaceAction} opening={openingWorkspace} error />;
  }
  if (map === null) {
    return <MapSourceState title="Loading workspace map" message="Extracting Rust packages and modules…" openWorkspace={openWorkspaceAction} opening={openingWorkspace} />;
  }
  if (selected === undefined) {
    return <MapSourceState title="Map data unavailable" message="The selected workspace did not return a usable map." openWorkspace={openWorkspaceAction} opening={openingWorkspace} error />;
  }

  const currentCrumbNames = validPath.map((id) => map.blockById.get(id)).filter((item): item is DisplayBlock => item !== undefined);
  const fileCrumbs = mapView !== "files" || scope === undefined ? [] : fileScopeCrumbs(fileScope, scopeDirectory(scope.sourcePath));
  const nodeSearch = map.nodes;
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setSearch("");
    if (event.key === "Enter" && search.trim().length > 0) {
      const term = search.trim().toLocaleLowerCase();
      const first = nodeSearch.find((node) => `${node.label} ${node.description} ${node.virtual ? node.pathLabel : node.sourcePath ?? ""}`.toLocaleLowerCase().includes(term));
      if (first !== undefined) selectSearchNode(first);
    }
  };

  const deleteNote = async (blockId: string) => {
    if (projectNotesSource === undefined || mapKey === null) return;
    const label = map.blockById.get(blockId)?.label ?? blockId;
    if (!window.confirm(`Delete the note on ${label}?`)) return;
    try {
      acceptProjectNotes(await projectNotesSource.remove({ workspaceId: mapKey, blockId }));
    } catch (error: unknown) {
      setNoteActionError(describeError(error, "Could not delete this note."));
    }
  };
  const chooseNoteMenuAction = (target: NoteMenuTarget, action: NoteMenuAction) => {
    const block = map.blockById.get(target.blockId);
    if (block === undefined) return;
    switch (action) {
      case "add-note":
        openNoteFor(block.id, target.line === undefined ? "" : `Line ${target.line}: `);
        return;
      case "edit-note":
        openNoteFor(block.id);
        return;
      case "delete-note":
        void deleteNote(block.id);
        return;
      case "open":
        openBlockInspector(block);
        return;
      case "copy-path":
        if (block.sourcePath !== null) {
          const text = target.line === undefined ? block.sourcePath : `${block.sourcePath}:${target.line}`;
          void navigator.clipboard?.writeText(text).catch(() => setNoteActionError("Could not copy the path."));
        }
        return;
      case "toggle-word-wrap":
        toggleWordWrap();
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };
  const noteMenuBlock = noteMenu === null ? undefined : map.blockById.get(noteMenu.blockId);
  const noteMenuView = noteMenu !== null && noteMenuBlock !== undefined ? (
    <NoteContextMenu
      x={noteMenu.x}
      y={noteMenu.y}
      title={noteMenu.line === undefined ? noteMenuBlock.label : `${noteMenuBlock.label} · line ${noteMenu.line}`}
      items={noteMenuItems({
        notesAvailable,
        hasNote: notedBlockIds.has(noteMenuBlock.id),
        canOpen: noteMenu.line === undefined && mapSource.editor !== undefined,
        sourcePath: noteMenuBlock.sourcePath,
        ...(noteMenu.line === undefined ? {} : { wordWrap, wordWrapShortcut }),
      })}
      onChoose={(action) => chooseNoteMenuAction(noteMenu, action)}
      onClose={closeNoteMenu}
    />
  ) : null;
  const selectedNoteAction = notesAvailable && !selected.virtual ? noteButtonLabel(notedBlockIds.has(selected.id)) : undefined;
  const inspectedNoteAction = notesAvailable && inspectedBlockId !== null ? noteButtonLabel(notedBlockIds.has(inspectedBlockId)) : undefined;

  const graphCanvas = (
    <div className="graph-canvas" aria-label={`${map.facts.project.name} architecture map`}>
      <div className="canvas-watermark">
        <span>{mapView === "files" ? "FILE TREE" : scope?.type === "workspace" ? "WORKSPACE MAP" : `${scope?.annotationKind ?? "BLOCK"} DETAIL`}</span>
        <span className="map-depth-controls">
          <div className="map-view" role="group" aria-label="Map view">
            <button type="button" aria-pressed={mapView === "modules"} onClick={() => chooseMapView("modules")}>Modules</button>
            <button type="button" aria-pressed={mapView === "files"} onClick={() => chooseMapView("files")}>Files</button>
          </div>
          <label className="map-depth">
            Depth
            <select
              aria-label="Map depth"
              value={mapDepth === "all" ? "all" : String(mapDepth)}
              onChange={(event) => {
                const next: MapDepth = event.target.value === "all" ? "all" : Number(event.target.value);
                setMapDepth(next);
                if (mapKey !== null) writeMapDepth(mapDepthStorage(), mapKey, next);
              }}
            >
              {(scope === undefined || map === null ? [DEFAULT_MAP_DEPTH, "all" as const] : depthOptions(
                mapView === "files" && fileRoot !== undefined && fileTree !== null
                  ? subtreeDepth(fileRoot, fileTree.nodeById)
                  : subtreeDepth(scope, map.blockById),
                mapDepth,
              )).map((choice) => (
                <option key={String(choice)} value={choice === "all" ? "all" : String(choice)}>
                  {choice === "all" ? "All" : String(choice)}
                </option>
              ))}
            </select>
          </label>
          <span className="child-count">{mapView === "files" && fileRoot !== undefined ? fileRoot.children.length : scopeChildren.length} direct children</span>
        </span>
      </div>
      {graphError.length > 0 ? (
        <div className="graph-message"><CircleAlert size={18} />Could not lay out this map: {graphError}</div>
      ) : graph.nodes.length === 0 ? (
        <div className="graph-message"><Activity size={18} />Preparing graph layout…</div>
      ) : (
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onMove={(_event, viewport) => { savedViewportRef.current = viewport; }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 0.18, maxZoom: 1.2 }}
          minZoom={0.12}
          maxZoom={1.7}
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <RestoreViewport
            refreshVersion={mapRefreshVersion}
            layoutRevision={layoutRevision}
            getSavedViewport={getSavedViewport}
          />
          <FitOnScopeChange
            scopeId={mapView === "files" && fileRoot !== undefined ? fileRoot.id : scopeId}
            viewKey={mapView === "files" ? `files:${fileScope}` : "modules"}
            layoutRevision={layoutRevision}
            focus={focusRequest}
            onFocusHandled={clearFocusRequest}
          />
          <Background color={theme === "blueprint" ? "rgba(227,238,255,.22)" : theme === "light" ? "#d4c9c0" : "#1b2733"} gap={26} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      )}
    </div>
  );
  const featureGroups = (
    <FeatureFooter
      map={map}
      group={chosenGroup}
      activeFeatureId={activeFeatureId}
      selectedId={selectedId}
      onGroupChange={(id) => { setActiveGroupId(id); setActiveFeatureId(null); }}
      onFeatureSelect={(feature) => { setSelectedId(feature.id); setActiveFeatureId(null); setActiveNodeId(null); setInspectedBlockId(null); }}
      onFeatureHover={(id) => { setActiveFeatureId(id); if (id !== null) setActiveNodeId(null); }}
    />
  );
  const mapContent = (
    <Splitter
      projectId={mapKey}
      splitterId="map-features"
      label="Resize map and feature groups"
      axis="y"
      defaultTrailingSize={197}
      minimumFirst={240}
      minimumSecond={140}
      className="map-content-splitter"
      first={graphCanvas}
      second={featureGroups}
    />
  );
  const mapColumn = (
    <main className="map-column">
      <div className="map-toolbar">
        <nav className="breadcrumbs" aria-label="Map breadcrumbs">
          {currentCrumbNames.map((crumb, index) => (
            <span className="breadcrumb-segment" key={crumb.id}>
              {index > 0 && <ChevronRight size={13} />}
              <button className={index === currentCrumbNames.length - 1 && fileCrumbs.length === 0 ? "current" : ""} type="button" onClick={() => chooseBreadcrumb(index)}>{crumb.label}</button>
            </span>
          ))}
          {fileCrumbs.map((crumb, index) => (
            <span className="breadcrumb-segment" key={`${crumb}:${index}`}>
              <ChevronRight size={13} />
              <button
                className={index === fileCrumbs.length - 1 ? "current" : ""}
                type="button"
                onClick={() => {
                  if (scope === undefined) return;
                  const scopeDir = scopeDirectory(scope.sourcePath);
                  const relative = fileCrumbs.slice(0, index + 1).join("/");
                  setFileScope(scopeDir === "" ? relative : `${scopeDir}/${relative}`);
                  setActiveFeatureId(null);
                  setActiveNodeId(null);
                }}
              >{crumb}</button>
            </span>
          ))}
        </nav>
        <div className="connection-legend">
          <span className="legend-item"><i className="legend-line contains-line" />contains <b>{directConnectionSummary.contains}</b></span>
          <span className="legend-item"><i className="legend-line dependency-line" />depends on <b>{directConnectionSummary.depends}</b></span>
          {staleCount > 0 && <span className="stale-count"><CircleAlert size={12} />{staleCount} changed</span>}
        </div>
        {history !== undefined && commits.length > 0 && (
          <label className="commit-picker" title="Light up the blocks a commit changed">
            <GitCommitHorizontal size={13} />
            <select
              aria-label="Show a commit's changes on the map"
              value={selectedCommit}
              onChange={(event) => setSelectedCommit(event.currentTarget.value)}
            >
              <option value="">No commit</option>
              {commits.map((commit) => (
                <option key={commit.id} value={commit.id}>{commit.shortId} {commit.summary}</option>
              ))}
            </select>
          </label>
        )}
        {projectNotesSource !== undefined && (
          <button
            className="project-notes-open-button"
            type="button"
            onClick={() => openNoteFor(noteTargetId)}
            title={`Project notes. Press ${addNoteShortcut} or right-click a block to add one.`}
          >
            <FileText size={13} /> Notes
            {projectNotes.kind === "ready" && projectNotes.notes.length > 0 && <span>{projectNotes.notes.length}</span>}
          </button>
        )}
      </div>
      {commitDiff.kind !== "idle" && (
        <div className="commit-diff-banner" role="status">
          {commitDiff.kind === "loading" && <span>Reading commit…</span>}
          {commitDiff.kind === "error" && <span className="commit-diff-error"><CircleAlert size={12} />{commitDiff.message}</span>}
          {commitDiff.kind === "ready" && (() => {
            const direct = commitDiff.changes.blocks.length;
            const mappedPaths = new Set([...map.blockById.values()].flatMap((block) => block.sourcePath === null ? [] : [block.sourcePath.replaceAll("\\", "/")]));
            const outside = unmappedFiles(commitDiff.changes, mappedPaths).length;
            return (
              <span>
                <code>{commitDiff.changes.commit.shortId}</code> {commitDiff.changes.commit.summary}
                {" · "}{direct === 1 ? "1 block changed" : `${direct} blocks changed`}
                {outside > 0 && ` · ${outside === 1 ? "1 file" : `${outside} files`} outside the map`}
              </span>
            );
          })()}
          <button type="button" className="commit-diff-clear" onClick={() => setSelectedCommit("")}>Clear</button>
        </div>
      )}
      {mapContent}
    </main>
  );
  const sidePanel = inspectedBlockId !== null && mapSource.editor !== undefined ? (
    <SourceInspectorPanel
      title={map.blockById.get(inspectedBlockId)?.label ?? "Source file"}
      inspection={inspection}
      theme={theme}
      openingEditor={openingEditor}
      editorError={editorActionError}
      onOpenInEditor={() => { void handleOpenInEditor(); }}
      onClose={() => setInspectedBlockId(null)}
      wordWrap={wordWrap}
      wordWrapShortcut={wordWrapShortcut}
      onToggleWordWrap={toggleWordWrap}
      {...(noteByBlockId.has(inspectedBlockId) ? {
        noteText: noteByBlockId.get(inspectedBlockId)!.text,
        noteStale: noteByBlockId.get(inspectedBlockId)!.stale,
      } : {})}
      {...(blockDiff === null ? {} : { diff: blockDiff })}
      {...(inspectedNoteAction === undefined ? {} : {
        noteAction: inspectedNoteAction,
        onAddNote: () => openNoteFor(inspectedBlockId),
        onLineContextMenu: (line: number, x: number, y: number) => {
          setNoteActionError("");
          setNoteMenu({ blockId: inspectedBlockId, x, y, line });
        },
      })}
    />
  ) : (
    <DetailsPanel
      node={selected}
      map={map}
      onOpen={(node) => { if (!node.virtual) openBlockInspector(node); }}
      onSelectBlock={setSelectedId}
      onBlockContextMenu={showBlockMenu}
      {...(noteByBlockId.has(selected.id) ? { note: noteByBlockId.get(selected.id)! } : {})}
      {...(selectedNoteAction === undefined ? {} : {
        noteAction: selectedNoteAction,
        onAddNote: () => openNoteFor(selected.id),
      })}
    />
  );

  return (
    <div className="workspace-shell" data-theme={theme} ref={shellRef}>
      <header className={`topbar${openWorkspaceAction === undefined ? "" : " desktop-topbar"}`}>
        <div className="brand-block">
          <div className="brand-mark"><img className="brand-logo" src="/lightwell-mark.svg" width={32} height={32} alt="Lightwell" draggable={false} /></div>
          <div><div className="brand-name">Lightwell<span className="brand-version">LOCAL</span></div></div>
        </div>
        <div className="project-select-wrap">
          <label htmlFor="project-select">PROJECT</label>
          <select
            id="project-select"
            value={mapKey ?? ""}
            onChange={(event) => {
              const id = event.currentTarget.value;
              if (mapCatalog.entries.some((entry) => entry.id === id)) {
                setMapKey(id);
                setInspectedBlockId(null);
              }
            }}
          >
            {mapCatalog.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <ChevronDown size={13} />
        </div>
        {openWorkspaceAction !== undefined && (
          <button className="open-workspace-button" type="button" onClick={handleOpenWorkspace} disabled={openingWorkspace}>
            <FolderOpen size={14} />{openingWorkspace ? "Opening…" : "Open workspace"}
          </button>
        )}
        <div className="global-search-wrap">
          <Search size={15} className="search-icon" />
          <input
            value={search}
            ref={searchRef}
            type="search"
            placeholder="Search blocks and features…"
            aria-label="Search map"
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={handleSearchKey}
          />
          <kbd><Command size={10} /> K</kbd>
          <SearchResults query={search} nodes={nodeSearch} onChoose={selectSearchNode} />
        </div>
        <div className="top-status">
          {mapSource.editor !== undefined && (
            <button className="editor-settings-button" type="button" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={13} />Settings
            </button>
          )}
          <span className="local-map-indicator"><span className="live-dot" />LOCAL MAP</span>
        </div>
      </header>

      {workspaceError.length > 0 && (
        <div className="workspace-error" role="alert">
          <span><CircleAlert size={14} />{workspaceError}</span>
          <button type="button" onClick={() => setWorkspaceError("")}>Dismiss</button>
        </div>
      )}

      <section className="overview-row" aria-label="Project summary">
        <div className="overview-title">
          <div className="workspace-glyph"><Box size={15} /></div>
          <div>
            <div className="overview-title-line">
              <h1>{map.facts.project.name}</h1>
              <span className="status-pill status-ready">ready</span>
              {projectDescription.length > 0 && <span className="overview-description">{projectDescription}</span>}
            </div>
          </div>
        </div>
        <div className="overview-metrics" role="group" aria-label="Project totals">
          <span className="overview-stat"><strong>{map.facts.stats.blocks.toLocaleString()}</strong> blocks</span>
          <span className="overview-separator" aria-hidden="true">·</span>
          <span className="overview-stat"><strong>{map.facts.stats.connections.toLocaleString()}</strong> connections</span>
          <span className="overview-separator" aria-hidden="true">·</span>
          <span className="overview-stat"><strong>{map.facts.stats.modules.toLocaleString()}</strong> modules</span>
          <span className="overview-separator" aria-hidden="true">·</span>
          <span className="overview-stat"><strong>{map.annotations.features.length.toLocaleString()}</strong> notes</span>
        </div>
      </section>

      <Splitter
        projectId={mapKey}
        splitterId="map-source"
        label="Resize map and source panel"
        axis="x"
        defaultTrailingSize={318}
        minimumFirst={520}
        minimumSecond={240}
        className="main-layout"
        first={mapColumn}
        second={sidePanel}
      />

      <svg className="connector-layer" aria-hidden="true">
        {connectorPaths.map((path, index) => <path className="feature-connector" d={path.d} stroke={path.color} key={`${path.d}-${index}`} />)}
      </svg>
      <div className="statusbar">
        <span><span className="statusbar-dot" /> Map is local and source-backed</span>
        <span><GitBranch size={12} /> {map.facts.project.name} <i /> cargo metadata --no-deps</span>
        <span><FileCode2 size={12} /> annotations kept in a separate overlay</span>
        <span className="statusbar-right"><Check size={12} /> {map.facts.stats.crates} crates mapped</span>
      </div>
      {noteMenuView}
      {noteActionError.length > 0 && (
        <div className="note-action-error" role="alert"><CircleAlert size={14} />{noteActionError}</div>
      )}
      {notesDialog !== null && projectNotesSource !== undefined && (
        <ProjectNotesDialog
          workspaceId={mapKey ?? ""}
          source={projectNotesSource}
          snapshot={projectNotes}
          map={map}
          currentBlockId={notesDialog.blockId !== null && map.blockById.has(notesDialog.blockId) ? notesDialog.blockId : null}
          initialText={notesDialog.initialText}
          onSnapshot={acceptProjectNotes}
          onClose={closeProjectNotes}
          onShowOnMap={(blockId) => {
            const block = map.blockById.get(blockId);
            if (block === undefined) return;
            closeProjectNotes();
            selectSearchNode(block);
          }}
        />
      )}
      {settingsOpen && mapSource.editor !== undefined && (
        <EditorSettingsPanel
          editor={mapSource.editor}
          themePreference={themePreference}
          theme={theme}
          onThemeChange={changeTheme}
          wordWrapShortcut={wordWrapShortcut}
          onWordWrapShortcutChange={changeWordWrapShortcut}
          onClose={closeSettingsPanel}
        />
      )}
    </div>
  );
}

export default App;
