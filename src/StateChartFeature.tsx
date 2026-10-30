import { useEffect, useState, type ReactNode } from "react";
import type { MapEditorSource } from "./map-source.js";
import {
  detectStateChart,
  layoutStateChart,
  type StateChart,
  type StateChartLayout,
} from "./state-chart.js";

interface SourceInspector {
  inspectBlock(workspaceId: string, blockId: string): ReturnType<MapEditorSource["inspectBlock"]>;
}

export type StateChartViewState =
  | { readonly kind: "select" }
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "empty"; readonly path: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly path: string; readonly chart: StateChart; readonly layout: StateChartLayout };

type LoadedStateChartViewState = Exclude<StateChartViewState, { readonly kind: "select" } | { readonly kind: "loading"; readonly label: string }>;

export interface StateChartFeatureProps {
  readonly editor: MapEditorSource;
  readonly workspaceId: string;
  readonly blockId: string;
  readonly blockLabel: string;
  readonly onClose: () => void;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (typeof error === "object" && error !== null && "message" in error
    && typeof error.message === "string" && error.message.length > 0) return error.message;
  return "Could not load the selected source file.";
}

export async function loadStateChartState(
  editor: SourceInspector,
  workspaceId: string,
  blockId: string,
): Promise<LoadedStateChartViewState> {
  try {
    const document = await editor.inspectBlock(workspaceId, blockId);
    const chart = detectStateChart(document);
    if (chart.machines.length === 0) return { kind: "empty", path: document.path };
    return { kind: "ready", path: document.path, chart, layout: layoutStateChart(chart) };
  } catch (error: unknown) {
    return { kind: "error", message: failureMessage(error) };
  }
}

function EmptyState({ children }: { readonly children: ReactNode }) {
  return <div className="state-chart-empty">{children}</div>;
}

export function StateChartView({ state, onClose }: {
  readonly state: StateChartViewState;
  readonly onClose: () => void;
}) {
  return (
    <section className="state-chart-view" aria-label={state.kind === "ready" ? `State chart for ${state.path}` : "State chart"}>
      <header className="state-chart-header">
        <div>
          <span className="state-chart-kicker">STATE CHART</span>
          <strong>{state.kind === "ready" || state.kind === "empty" ? state.path : "Source-derived states"}</strong>
        </div>
        <button type="button" onClick={onClose}>Back to map</button>
      </header>
      {state.kind === "select" && <EmptyState>Select a source-backed block to chart its explicit transitions.</EmptyState>}
      {state.kind === "loading" && <EmptyState>Reading {state.label}…</EmptyState>}
      {state.kind === "empty" && (
        <EmptyState>No explicit state transitions were found in this file. Lightwell charts enum transitions, not inferred control flow.</EmptyState>
      )}
      {state.kind === "error" && <EmptyState><span role="alert">{state.message}</span></EmptyState>}
      {state.kind === "ready" && (
        <div className="state-chart-scroll">
          <svg
            className="state-chart-canvas"
            viewBox={`0 0 ${state.layout.width} ${state.layout.height}`}
            width={state.layout.width}
            height={state.layout.height}
            role="img"
            aria-label={`State chart for ${state.path}`}
          >
            <defs>
              <marker id="state-chart-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
              <pattern id="state-chart-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" />
              </pattern>
            </defs>
            <rect className="state-chart-grid-background" width="100%" height="100%" />
            <rect className="state-chart-grid" width="100%" height="100%" fill="url(#state-chart-grid)" />
            {state.layout.regions.map((region) => (
              <g key={region.id}>
                <rect className="state-chart-region" x={region.x} y={region.y} width={region.width} height={region.height} rx="8" />
                <text className="state-chart-region-label" x={region.x + 14} y={region.y + 23}>{region.label}</text>
                <text className="state-chart-language" x={region.x + region.width - 14} y={region.y + 23} textAnchor="end">{region.language}</text>
              </g>
            ))}
            {state.layout.edges.map((edge) => (
              <g key={edge.id}>
                <polyline
                  className="state-chart-edge"
                  points={edge.points.map((point) => `${point.x},${point.y}`).join(" ")}
                  markerEnd="url(#state-chart-arrow)"
                />
                <text className="state-chart-edge-label" x={edge.labelX} y={edge.labelY}>{edge.label}</text>
              </g>
            ))}
            {state.layout.nodes.map((node) => {
              const kinds = [node.kind === "summary" ? "summary state" : "state"];
              if (node.initial) kinds.push("initial state");
              if (node.terminal) kinds.push("terminal state");
              if (node.line !== null) kinds.push(`line ${node.line}`);
              return (
                <g className={`state-chart-node${node.initial ? " is-initial" : ""}${node.terminal ? " is-terminal" : ""}${node.kind === "summary" ? " is-summary" : ""}`} key={node.id}>
                  <title>{`${node.label}, ${kinds.join(", ")}`}</title>
                  <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="6" />
                  {node.initial && <circle className="state-chart-initial-dot" cx={node.x + node.width - 13} cy={node.y + 13} r="4" />}
                  <text className="state-chart-node-label" x={node.x + 14} y={node.y + 25}>{node.label}</text>
                  <text className="state-chart-node-meta" x={node.x + 14} y={node.y + 43}>
                    {node.kind === "summary" ? "bounded result" : node.line === null ? "source state" : `line ${node.line}`}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {state.kind === "ready" && (
        <footer className="state-chart-legend" aria-label="State chart legend">
          <span><i className="legend-initial" />initial</span>
          <span><i className="legend-terminal" />terminal</span>
          <span><i className="legend-transition" />transition</span>
          {(state.chart.omittedStates > 0 || state.chart.omittedTransitions > 0) && (
            <span>{state.chart.omittedStates} states and {state.chart.omittedTransitions} transitions omitted</span>
          )}
        </footer>
      )}
    </section>
  );
}

export default function StateChartFeature({ editor, workspaceId, blockId, blockLabel, onClose }: StateChartFeatureProps) {
  const [state, setState] = useState<StateChartViewState>({ kind: "loading", label: blockLabel });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading", label: blockLabel });
    void loadStateChartState(editor, workspaceId, blockId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [blockId, blockLabel, editor, workspaceId]);
  return <StateChartView state={state} onClose={onClose} />;
}
