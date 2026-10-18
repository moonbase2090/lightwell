import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { CommitDiffEntry } from "./commit-diff-summary.js";

function formatCounts(added: number, removed: number, binary: boolean): string {
  if (binary) return "binary";
  return `+${added} −${removed}`;
}

export default function CommitDiffSummary({
  summary,
  entries,
  expanded,
  onToggleExpanded,
  onlyChanged,
  onOnlyChangedChange,
  focusIndex,
  onFocusIndexChange,
  onNavigate,
  onClear,
}: {
  readonly summary: ReactNode;
  readonly entries: readonly CommitDiffEntry[];
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly onlyChanged: boolean;
  readonly onOnlyChangedChange: (value: boolean) => void;
  readonly focusIndex: number;
  readonly onFocusIndexChange: (index: number) => void;
  readonly onNavigate: (entry: CommitDiffEntry) => void;
  readonly onClear: () => void;
}) {
  const hasList = entries.length > 0;
  const positionLabel = hasList ? `${focusIndex + 1} / ${entries.length}` : "";

  return (
    <div className={`commit-diff-banner${expanded ? " expanded" : ""}`} role="status">
      <div className="commit-diff-banner-row">
        <button
          type="button"
          className="commit-diff-expand"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse change list" : "Expand change list"}
          onClick={onToggleExpanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="commit-diff-summary-text">{summary}</span>
        {hasList && (
          <>
            <label className="commit-diff-only-changed">
              <input
                type="checkbox"
                checked={onlyChanged}
                onChange={(event) => onOnlyChangedChange(event.currentTarget.checked)}
              />
              Only changed
            </label>
            <span className="commit-diff-position" aria-live="polite">{positionLabel}</span>
            <button
              type="button"
              className="commit-diff-step"
              disabled={!hasList}
              onClick={() => onFocusIndexChange((focusIndex + entries.length - 1) % entries.length)}
            >
              Prev
            </button>
            <button
              type="button"
              className="commit-diff-step"
              disabled={!hasList}
              onClick={() => onFocusIndexChange((focusIndex + 1) % entries.length)}
            >
              Next
            </button>
            <span className="commit-diff-shortcut-hint" title="Previous and next change">[ ]</span>
          </>
        )}
        <button type="button" className="commit-diff-clear" onClick={onClear}>Clear</button>
      </div>
      {expanded && (
        <div className="commit-diff-details">
          <p className="commit-diff-legend">
            <span><span className="diff-added">+n</span> lines added</span>
            <span><span className="diff-removed">−n</span> lines removed</span>
            <span>Dimmed blocks are unchanged</span>
            <span>Connections: <span className="legend-added">added</span>, <span className="legend-changed">changed</span>, <span className="legend-removed">removed</span></span>
          </p>
          <ol className="commit-diff-list">
            {entries.map((entry, index) => {
              const focused = index === focusIndex;
              const label = entry.kind === "block" ? entry.label : entry.path;
              const counts = formatCounts(entry.added, entry.removed, entry.kind === "file" && entry.binary);
              return (
                <li key={entry.kind === "block" ? entry.blockId : entry.path}>
                  <button
                    type="button"
                    className={`commit-diff-item${focused ? " focused" : ""}`}
                    aria-current={focused ? "true" : undefined}
                    onClick={() => {
                      onFocusIndexChange(index);
                      onNavigate(entry);
                    }}
                  >
                    <span className="commit-diff-item-kind">{entry.kind === "block" ? "Block" : "File"}</span>
                    <span className="commit-diff-item-label">{label}</span>
                    <span className="commit-diff-item-counts">{counts}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
