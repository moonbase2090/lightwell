import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
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
  FolderOpen,
  GitBranch,
  Layers3,
  Search,
  Waypoints,
} from "lucide-react";
import {
  Background,
  Controls,
  ReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { MapSource, MapSourceEntry } from "./map-source.js";
import type { AnnotationOverlay, DisplayBlock, DisplayFeature, DisplayNode, FactConnection, ResolvedMap } from "./model.js";
import { parseAnnotationOverlay, parseFactMap, resolveMap } from "./schema.js";
import BlockNodeView, { type MapNode } from "./viewer/BlockNode.js";
import { emphasizeGraph, layoutBlocks } from "./viewer/layout.js";

const nodeTypes = { codeBlock: BlockNodeView };
const featureColors = ["#88a8ff", "#5ed7c0", "#d19af5", "#efba78", "#80c7f2", "#f08db4", "#a8d989", "#e4cf73"];

type MapCatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly entries: readonly MapSourceEntry[] }
  | { readonly kind: "error"; readonly message: string };

type LoadedMapState =
  | { readonly kind: "loading"; readonly id: string | null }
  | { readonly kind: "ready"; readonly id: string; readonly map: ResolvedMap }
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

function Metric({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone?: string }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span className="metric-value">{value.toLocaleString()}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
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
          <span className={`result-status status-${node.status}`}>{node.status}</span>
        </button>
      ))}
    </div>
  );
}

function DetailsPanel({
  node,
  map,
  onOpen,
  onSelectBlock,
}: {
  readonly node: DisplayNode;
  readonly map: ResolvedMap;
  readonly onOpen: (node: DisplayNode) => void;
  readonly onSelectBlock: (id: string) => void;
}) {
  if (node.virtual) {
    const members = node.memberIds.map((id) => map.blockById.get(id)).filter((block): block is DisplayBlock => block !== undefined);
    return (
      <aside className="details-panel">
        <div className="detail-kicker"><span className="kind-dot feature-dot" /> FEATURE GROUP</div>
        <div className="detail-title-row"><h2>{node.label}</h2><span className={`status-pill status-${node.status}`}>{formatStatus(node.status)}</span></div>
        <p className="detail-description">{node.description}</p>
        {node.annotationState === "changed" && <div className="stale-note"><CircleAlert size={14} /> Source changed since this note was written.</div>}
        <div className="detail-divider" />
        <div className="detail-section-label">CONNECTED BLOCKS <span>{members.length}</span></div>
        <div className="member-list">
          {members.map((member) => (
            <button className="member-row" key={member.id} type="button" onClick={() => { onSelectBlock(member.id); onOpen(member); }}>
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
      <div className="detail-title-row"><h2>{node.label}</h2><span className={`status-pill status-${node.status}`}>{formatStatus(node.status)}</span></div>
      <p className="detail-description">{node.description}</p>
      {node.annotationState === "changed" && <div className="stale-note"><CircleAlert size={14} /> Code changed since this note was written.</div>}
      {node.annotationState === "missing" && <div className="stale-note"><CircleAlert size={14} /> Add a description to the annotation overlay.</div>}

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
              <button className="member-row" key={child.id} type="button" onClick={() => { onSelectBlock(child.id); onOpen(child); }}>
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

function App({ mapSource }: { readonly mapSource: MapSource }) {
  const [mapCatalog, setMapCatalog] = useState<MapCatalogState>({ kind: "loading" });
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [loadedMap, setLoadedMap] = useState<LoadedMapState>({ kind: "loading", id: null });
  const [workspaceError, setWorkspaceError] = useState("");
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [mapRequestVersion, setMapRequestVersion] = useState(0);
  const [scopePath, setScopePath] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [activeGroupId, setActiveGroupId] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeFeatureId, setActiveFeatureId] = useState<string | null>(null);
  const [baseGraph, setBaseGraph] = useState<{ readonly nodes: MapNode[]; readonly edges: ReturnType<typeof emphasizeGraph>["edges"] }>({ nodes: [], edges: [] });
  const [graphError, setGraphError] = useState("");
  const shellRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [connectorPaths, setConnectorPaths] = useState<readonly ConnectorPath[]>([]);

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
      setMapRequestVersion((version) => version + 1);
    } catch (error: unknown) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not open this Rust workspace.");
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
            message: error instanceof Error ? error.message : "Could not list available maps.",
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
    setLoadedMap({ kind: "loading", id: mapKey });
    void Promise.resolve()
      .then(() => mapSource.loadMap(mapKey))
      .then((document) => resolveMap(
        parseFactMap(document.facts),
        parseAnnotationOverlay(document.annotations),
      ))
      .then((map) => {
        if (!cancelled) {
          setLoadedMap({ kind: "ready", id: mapKey, map });
          setMapCatalog((current) => current.kind === "ready"
            ? {
                kind: "ready",
                entries: current.entries.map((entry) => entry.id === mapKey
                  ? { ...entry, label: map.facts.project.name }
                  : entry),
              }
            : current);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadedMap({
            kind: "error",
            id: mapKey,
            message: error instanceof Error ? error.message : "Could not load map data.",
          });
        }
      });
    return () => { cancelled = true; };
  }, [mapSource, mapKey, mapRequestVersion]);

  const source = mapCatalog.kind === "ready"
    ? mapCatalog.entries.find((entry) => entry.id === mapKey)
    : undefined;
  const openWorkspaceAction = mapSource.openWorkspace === undefined ? undefined : handleOpenWorkspace;
  const map = loadedMap.kind === "ready" && loadedMap.id === mapKey ? loadedMap.map : null;
  const rootId = map?.facts.project.id ?? "";
  const validPath = map !== null && scopePath.length > 0 && scopePath[0] === rootId
    ? scopePath.filter((id) => map.blockById.has(id))
    : rootId.length > 0 ? [rootId] : [];
  const scopeId = validPath.at(-1) ?? rootId;
  const scope = map?.blockById.get(scopeId) ?? (map === null ? undefined : map.blockById.get(rootId));
  const scopeChildren = useMemo(() => scope?.children
    .map((id) => map?.blockById.get(id))
    .filter((block): block is DisplayBlock => block !== undefined) ?? [], [map, scopeId]);
  const visibleBlocks = useMemo(() => scope === undefined ? [] : [scope, ...scopeChildren], [scope, scopeChildren]);
  const connectionsInScope = displayConnections(scopeId, visibleBlocks, map?.connections ?? []);
  const selected = map?.nodeById.get(selectedId) ?? scope;
  const activeFeature = activeFeatureId === null ? undefined : map?.nodeById.get(activeFeatureId);
  const activeFeatureMembers = useMemo(() => activeFeature?.virtual === true ? new Set(activeFeature.memberIds) : null, [activeFeature]);
  const chosenGroup = map?.annotations.groups.find((group) => group.id === activeGroupId) ?? map?.annotations.groups[0];
  const staleCount = map?.nodes.filter((node) => node.annotationState !== "current").length ?? 0;
  const directConnectionSummary = connectionsInScope;
  const projectDescription = map?.blockById.get(rootId)?.description ?? "Source-backed workspace map.";

  const setHoverNode = useCallback((id: string | null) => {
    setActiveNodeId(id);
    if (id !== null) setActiveFeatureId(null);
  }, []);

  useEffect(() => {
    if (map === null) return;
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
    layoutBlocks({ blocks: visibleBlocks, connections: map.connections })
      .then((graph) => { if (!cancelled) setBaseGraph(graph); })
      .catch((error: unknown) => {
        if (!cancelled) setGraphError(error instanceof Error ? error.message : "Graph layout failed.");
      });
    return () => { cancelled = true; };
  }, [map, scopeId, visibleBlocks]);

  const graph = useMemo(() => emphasizeGraph({
    nodes: baseGraph.nodes,
    edges: baseGraph.edges,
    activeNodeId,
    activeFeatureMemberIds: activeFeatureMembers,
    onHover: setHoverNode,
  }), [baseGraph, activeNodeId, activeFeatureMembers, setHoverNode]);

  const activateBlock = useCallback((block: DisplayBlock) => {
    setSelectedId(block.id);
    setActiveFeatureId(null);
    setActiveNodeId(null);
    if (block.children.length > 0) setScopePath((current) => current.at(-1) === block.id ? current : [...current, block.id]);
  }, []);

  const selectSearchNode = useCallback((node: DisplayNode) => {
    setSearch("");
    setActiveNodeId(null);
    if (node.virtual) {
      setSelectedId(node.id);
      const matchingGroup = map?.annotations.groups.find((group) => group.featureIds.includes(node.id));
      if (matchingGroup !== undefined) setActiveGroupId(matchingGroup.id);
      return;
    }
    setSelectedId(node.id);
    if (map === null) return;
    const ancestors: string[] = [];
    let cursor: DisplayBlock | undefined = node;
    while (cursor !== undefined) {
      ancestors.unshift(cursor.id);
      cursor = cursor.parentId === null ? undefined : map.blockById.get(cursor.parentId);
    }
    setScopePath(ancestors.length > 1 ? ancestors.slice(0, -1) : ancestors);
  }, [map]);

  const onNodeClick: NodeMouseHandler<MapNode> = useCallback((_event, node) => {
    const block = map?.blockById.get(node.id);
    if (block !== undefined) activateBlock(block);
  }, [activateBlock, map]);

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
    setSelectedId(path.at(-1) ?? rootId);
    setActiveFeatureId(null);
    setActiveNodeId(null);
  };

  if (mapCatalog.kind === "loading") {
    return <MapSourceState title="Loading workspaces" message="Reading recent workspaces…" openWorkspace={openWorkspaceAction} opening={openingWorkspace} />;
  }
  if (mapCatalog.kind === "error") {
    return <MapSourceState title="Could not load recent workspaces" message={mapCatalog.message} openWorkspace={openWorkspaceAction} opening={openingWorkspace} error />;
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
  const nodeSearch = map.nodes;
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setSearch("");
    if (event.key === "Enter" && search.trim().length > 0) {
      const term = search.trim().toLocaleLowerCase();
      const first = nodeSearch.find((node) => `${node.label} ${node.description} ${node.virtual ? node.pathLabel : node.sourcePath ?? ""}`.toLocaleLowerCase().includes(term));
      if (first !== undefined) selectSearchNode(first);
    }
  };

  return (
    <div className="workspace-shell" ref={shellRef}>
      <header className={`topbar${openWorkspaceAction === undefined ? "" : " desktop-topbar"}`}>
        <div className="brand-block">
          <div className="brand-mark"><Waypoints size={17} strokeWidth={1.8} /></div>
          <div><div className="brand-name">Lightwell<span className="brand-version">LOCAL</span></div><div className="brand-caption">turning the lights on in the Dark Factory</div></div>
        </div>
        <div className="project-select-wrap">
          <label htmlFor="project-select">PROJECT</label>
          <select
            id="project-select"
            value={mapKey ?? ""}
            onChange={(event) => {
              const id = event.currentTarget.value;
              if (mapCatalog.entries.some((entry) => entry.id === id)) setMapKey(id);
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
        <div className="top-status"><span className="live-dot" /><span>LOCAL MAP</span></div>
      </header>

      {workspaceError.length > 0 && (
        <div className="workspace-error" role="alert">
          <span><CircleAlert size={14} />{workspaceError}</span>
          <button type="button" onClick={() => setWorkspaceError("")}>Dismiss</button>
        </div>
      )}

      <div className="overview-row">
        <div className="overview-title">
          <div className="workspace-glyph"><Box size={18} /></div>
          <div>
            <div className="overview-title-line"><h1>{map.facts.project.name}</h1><span className="status-pill status-ready">ready</span></div>
            <p>{projectDescription}</p>
          </div>
        </div>
        <div className="overview-metrics">
          <Metric label="blocks" value={map.facts.stats.blocks} />
          <Metric label="connections" value={map.facts.stats.connections} tone="metric-blue" />
          <Metric label="Rust modules" value={map.facts.stats.modules} tone="metric-violet" />
          <Metric label="feature notes" value={map.annotations.features.length} tone="metric-amber" />
        </div>
      </div>

      <div className="main-layout">
        <main className="map-column">
          <div className="map-toolbar">
            <nav className="breadcrumbs" aria-label="Map breadcrumbs">
              {currentCrumbNames.map((crumb, index) => (
                <span className="breadcrumb-segment" key={crumb.id}>
                  {index > 0 && <ChevronRight size={13} />}
                  <button className={index === currentCrumbNames.length - 1 ? "current" : ""} type="button" onClick={() => chooseBreadcrumb(index)}>{crumb.label}</button>
                </span>
              ))}
            </nav>
            <div className="connection-legend">
              <span className="legend-item"><i className="legend-line contains-line" />contains <b>{directConnectionSummary.contains}</b></span>
              <span className="legend-item"><i className="legend-line dependency-line" />depends on <b>{directConnectionSummary.depends}</b></span>
              {staleCount > 0 && <span className="stale-count"><CircleAlert size={12} />{staleCount} changed</span>}
            </div>
          </div>

          <div className="graph-canvas" aria-label={`${map.facts.project.name} architecture map`}>
            <div className="canvas-watermark"><span>{scope?.type === "workspace" ? "WORKSPACE MAP" : `${scope?.annotationKind ?? "BLOCK"} DETAIL`}</span><span>{scopeChildren.length} direct children</span></div>
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
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ padding: 0.2, minZoom: 0.18, maxZoom: 1.2 }}
                minZoom={0.12}
                maxZoom={1.7}
                defaultEdgeOptions={{ type: "smoothstep" }}
              >
                <Background color="#1b2733" gap={26} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
            )}
          </div>

          <FeatureFooter
            map={map}
            group={chosenGroup}
            activeFeatureId={activeFeatureId}
            selectedId={selectedId}
            onGroupChange={(id) => { setActiveGroupId(id); setActiveFeatureId(null); }}
            onFeatureSelect={(feature) => { setSelectedId(feature.id); setActiveFeatureId(null); setActiveNodeId(null); }}
            onFeatureHover={(id) => { setActiveFeatureId(id); if (id !== null) setActiveNodeId(null); }}
          />
        </main>

        <DetailsPanel
          node={selected}
          map={map}
          onOpen={(node) => { if (!node.virtual) activateBlock(node); }}
          onSelectBlock={setSelectedId}
        />
      </div>

      <svg className="connector-layer" aria-hidden="true">
        {connectorPaths.map((path, index) => <path className="feature-connector" d={path.d} stroke={path.color} key={`${path.d}-${index}`} />)}
      </svg>
      <div className="statusbar">
        <span><span className="statusbar-dot" /> Map is local and source-backed</span>
        <span><GitBranch size={12} /> {map.facts.project.name} <i /> cargo metadata --no-deps</span>
        <span><FileCode2 size={12} /> annotations kept in a separate overlay</span>
        <span className="statusbar-right"><Check size={12} /> {map.facts.stats.crates} crates mapped</span>
      </div>
    </div>
  );
}

export default App;
