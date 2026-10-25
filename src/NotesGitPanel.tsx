import { useEffect, useState } from "react";
import type { NotesGitStatus, ProjectNotesGitSource, ProjectNoteView } from "./map-source.js";

function statusText(status: NotesGitStatus): string {
  switch (status.kind) {
    case "notRepository": return "This project is not in a Git repository. Initialize Git to share notes.";
    case "missing": return "Save this note before committing it.";
    case "ignored": return ".lightwell/notes.json is ignored. Change your Git ignore rules to share notes.";
    case "conflicted": return "Resolve the notes merge conflict in Git, then refresh.";
    case "unavailable": return status.message;
    case "ready": return `.lightwell/notes.json: ${status.state}. ${status.noteChanged ? "This note has changes to commit." : "This note matches the latest commit."}`;
  }
}

function errorMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return "Git could not commit this note. Check Git configuration and retry.";
}

export default function NotesGitPanel({ source, workspaceId, note, disabled, onBusy, refreshToken = 0, disabledReason }: {
  readonly source: ProjectNotesGitSource;
  readonly workspaceId: string;
  readonly note: ProjectNoteView;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly refreshToken?: number;
  readonly onBusy: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<NotesGitStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setStatus(null);
    setFeedback("");
    setError("");
    void source.status({ workspaceId, blockId: note.blockId }).then((next) => {
      if (active) setStatus(next);
    }).catch((cause: unknown) => {
      if (active) setStatus({ kind: "unavailable", message: errorMessage(cause) });
    });
    return () => { active = false; };
  }, [source, workspaceId, note, refresh, refreshToken]);

  const commit = async () => {
    if (disabled || busy || status?.kind !== "ready" || !status.noteChanged) return;
    setBusy(true);
    onBusy(true);
    setError("");
    setFeedback("");
    try {
      const result = await source.commit({ workspaceId, blockId: note.blockId, text: note.text, sourceFingerprint: note.sourceFingerprint, revision: status.revision });
      setStatus(result.status);
      setFeedback(result.commitId === null ? "This note is already committed." : `Note committed as ${result.commitId.slice(0, 8)}.`);
    } catch (cause: unknown) {
      setError(`Your note is saved. ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };

  return <div className="notes-git-panel" aria-label="Note Git sharing">
    <p aria-live="polite">{status === null ? "Checking notes Git status…" : statusText(status)}</p>
    <p>Commit only this saved note to share it through Git. Other notes stay as they are. Nothing is pushed.</p>
    {disabled && !busy && <p>{disabledReason ?? "Save your changes before committing this note."}</p>}
    {feedback.length > 0 && <p role="status">{feedback}</p>}
    {error.length > 0 && <p className="project-notes-error" role="alert">{error}</p>}
    <div className="notes-git-actions">
      <button className="notes-new-button" type="button" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh Git status</button>
      <button className="notes-save-button" type="button" disabled={disabled || busy || status?.kind !== "ready" || !status.noteChanged} onClick={() => void commit()}>{busy ? "Committing…" : "Commit this note"}</button>
    </div>
  </div>;
}
