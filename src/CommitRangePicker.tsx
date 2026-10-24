import { useEffect, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { CommitRangePreset, CommitSummary, MapHistorySource, ResolvedCommitRange } from "./map-source.js";

type Choice = { readonly kind: "off" } | { readonly kind: "lastCommit" | "lastFive" | "sinceRelease" }
  | { readonly kind: "custom"; readonly from: string | null; readonly to: string };
type Ancestors = { readonly kind: "loading" } | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly commits: readonly CommitSummary[] };


function CustomRange({ history, workspaceId, commits, choice, onChange }: {
  readonly history: MapHistorySource;
  readonly workspaceId: string;
  readonly commits: readonly CommitSummary[];
  readonly choice: Extract<Choice, { kind: "custom" }>;
  readonly onChange: (choice: Choice) => void;
}) {
  const [ancestors, setAncestors] = useState<Ancestors>({ kind: "loading" });
  const customTo = choice.to;

  useEffect(() => {
    if (customTo === "") return;
    let cancelled = false;
    setAncestors({ kind: "loading" });
    void history.listSinceCommits(workspaceId, customTo).then((list) => {
      if (!cancelled) setAncestors({ kind: "ready", commits: list });
    }).catch(() => { if (!cancelled) setAncestors({ kind: "error" }); });
    return () => { cancelled = true; };
  }, [history, workspaceId, customTo]);

  return <div className="commit-custom-range">
      <label><span>From (older)</span>
        <select aria-label="From (older commit, excluded)" aria-describedby="commit-range-help" value={choice.from ?? ""}
          disabled={ancestors.kind !== "ready"} onChange={(event) => onChange({ ...choice, from: event.currentTarget.value || null })}>
          <option value="">Before To (one commit)</option>
          {ancestors.kind === "ready" && [...ancestors.commits].reverse().map((commit) =>
            <option key={commit.id} value={commit.id}>{commit.shortId} {commit.summary}</option>)}
        </select>
      </label>
      <span aria-hidden="true">→</span>
      <label><span>To (newer)</span>
        <select aria-label="To (newer commit, included)" aria-describedby="commit-range-help" value={choice.to}
          onChange={(event) => onChange({ kind: "custom", from: null, to: event.currentTarget.value })}>
          {[...commits].reverse().map((commit) => <option key={commit.id} value={commit.id}>{commit.shortId} {commit.summary}</option>)}
        </select>
      </label>
      <span id="commit-range-help" className="commit-range-help">Changes after From, through To. From lists older ancestors in the recent history.</span>
      {ancestors.kind === "loading" && <span role="status">Reading older commits…</span>}
      {ancestors.kind === "error" && <span role="status">Could not read older commits. Retry Custom or choose another preset.</span>}
    </div>;
}

export default function CommitRangePicker({ history, workspaceId, commits, loading, error, onResolved }: {
  readonly history: MapHistorySource;
  readonly workspaceId: string;
  readonly commits: readonly CommitSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onResolved: (range: ResolvedCommitRange | null) => void;
}) {
  const [choice, setChoice] = useState<Choice>({ kind: "off" });
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    onResolved(null);
    if (choice.kind === "off") { setNotice(null); return; }
    const through = choice.kind === "custom" ? choice.to : commits[0]?.id;
    if (!through) return;
    const preset: CommitRangePreset = choice.kind === "custom" ? { kind: "custom", from: choice.from } : choice;
    let cancelled = false;
    setNotice("Reading range…");
    void history.resolveRange(workspaceId, through, preset).then((range) => {
      if (cancelled) return;
      setNotice(null);
      onResolved(range);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [choice, commits, history, workspaceId, onResolved]);

  return <div className="commit-picker">
    <label>
      <GitCommitHorizontal size={13} aria-hidden="true" />
      <span className="commit-picker-label">Show changes</span>
      <select aria-label="Show changes" value={choice.kind} disabled={loading || commits.length === 0}
        onChange={(event) => {
          const kind = event.currentTarget.value;
          if (kind === "off" || kind === "lastCommit" || kind === "lastFive" || kind === "sinceRelease") setChoice({ kind });
          else if (kind === "custom" && commits[0]) setChoice({ kind, from: null, to: commits[0].id });
        }}>
        <option value="off">Off</option>
        <option value="lastCommit">Last commit</option>
        <option value="lastFive">Last 5 commits</option>
        <option value="sinceRelease">Since last release</option>
        <option value="custom">Custom…</option>
      </select>
    </label>
    {choice.kind === "custom" && <CustomRange history={history} workspaceId={workspaceId} commits={commits} choice={choice} onChange={setChoice} />}
    {(loading || error || commits.length === 0 || notice) && <span className="commit-range-notice" role="status">
      {loading ? "Reading history…" : error ?? (commits.length === 0 ? "No commit history available." : notice)}
    </span>}
  </div>;
}
