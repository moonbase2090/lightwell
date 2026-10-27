import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, CircleAlert, FileText, MapPin, Plus, Save, Trash2, X } from "lucide-react";
import type { ResolvedMap } from "./model.js";
import type { ProjectNoteView, ProjectNotesSnapshot, ProjectNotesSource } from "./map-source.js";
import NotesGitPanel from "./NotesGitPanel.js";

type NoteEditor =
  | { readonly kind: "new"; readonly blockId: string; readonly text: string }
  | { readonly kind: "saved"; readonly blockId: string; readonly text: string };

interface ProjectNotesDialogProps {
  readonly workspaceId: string;
  readonly source: ProjectNotesSource;
  readonly snapshot: ProjectNotesSnapshot;
  readonly map: ResolvedMap;
  readonly currentBlockId: string | null;
  /** Starting text for a new note, such as a line reference from the source inspector. */
  readonly initialText?: string;
  readonly onSnapshot: (snapshot: ProjectNotesSnapshot) => void;
  readonly onClose: () => void;
  /** Close the dialog and reveal the note's block on the map. */
  readonly onShowOnMap?: (blockId: string) => void;
}

function noteEditorForBlock(blockId: string, notes: readonly ProjectNoteView[]): NoteEditor {
  const note = notes.find((item) => item.blockId === blockId);
  return note === undefined
    ? { kind: "new", blockId, text: "" }
    : { kind: "saved", blockId, text: note.text };
}

function noteLabel(note: ProjectNoteView, map: ResolvedMap): string {
  return map.blockById.get(note.blockId)?.label ?? note.blockId;
}

function noteStatus(note: ProjectNoteView, map: ResolvedMap): string {
  if (!note.stale) return "Current";
  return map.blockById.has(note.blockId) ? "Source changed" : "Block removed";
}

function noteErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (typeof error === "object" && error !== null && "message" in error
    && typeof error.message === "string" && error.message.length > 0) return error.message;
  return fallback;
}

/** True when Delete stale removed the open saved note and the editor must leave it. */
export function shouldResetEditorAfterStaleRemoval(
  editor: NoteEditor,
  remainingBlockIds: ReadonlySet<string>,
): boolean {
  return editor.kind === "saved" && !remainingBlockIds.has(editor.blockId);
}

export default function ProjectNotesDialog({
  workspaceId,
  source,
  snapshot,
  map,
  currentBlockId,
  initialText = "",
  onSnapshot,
  onClose,
  onShowOnMap,
}: ProjectNotesDialogProps) {
  const notes = useMemo(() => snapshot.kind === "ready"
    ? [...snapshot.notes].sort((left, right) => Number(left.stale) - Number(right.stale)
      || left.blockId.localeCompare(right.blockId))
    : [], [snapshot]);
  const [editor, setEditor] = useState<NoteEditor>(() => {
    const initial = noteEditorForBlock(currentBlockId ?? "", notes);
    return initial.kind === "new" ? { ...initial, text: initialText } : initial;
  });
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), textarea:not(:disabled)",
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    textareaRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, editor.blockId, editor.kind]);

  const selectedNote = notes.find((note) => note.blockId === editor.blockId);
  const isDirty = editor.kind === "new"
    ? editor.text.length > 0
    : selectedNote === undefined || selectedNote.text !== editor.text;
  const editorBlock = map.blockById.get(editor.blockId);
  const staleCount = notes.filter((note) => note.stale).length;
  const staleActionsEnabled = source.markReviewed !== undefined && source.removeStale !== undefined;
  const showMarkReviewed = staleActionsEnabled
    && selectedNote?.stale === true
    && editorBlock !== undefined
    && editor.kind === "saved"
    && snapshot.kind === "ready";
  const canMarkReviewed = showMarkReviewed && !saving && !committing && !isDirty;
  const canSave = snapshot.kind === "ready"
    && !saving
    && !committing
    && editor.blockId.length > 0
    && editor.text.trim().length > 0;

  const chooseEditor = (next: NoteEditor) => {
    if (committing) return;
    if (isDirty && !window.confirm("Discard unsaved note changes?")) return;
    setEditor(next);
    setError("");
    setSavedMessage("");
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    setSavedMessage("");
    try {
      const input = { workspaceId, blockId: editor.blockId, text: editor.text };
      const updated = editor.kind === "new"
        ? await source.add(input)
        : await source.edit(input);
      onSnapshot(updated);
      setEditor({ kind: "saved", blockId: editor.blockId, text: editor.text });
      setSavedMessage("Saved in .lightwell/notes.json");
    } catch (cause: unknown) {
      setError(noteErrorMessage(cause, "Could not save this project note."));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
      if (!dialogRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      void handleSave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const handleRemove = async () => {
    if (editor.kind !== "saved" || saving || committing) return;
    setSaving(true);
    setError("");
    setSavedMessage("");
    try {
      const updated = await source.remove({ workspaceId, blockId: editor.blockId });
      onSnapshot(updated);
      setEditor(noteEditorForBlock(currentBlockId ?? "", updated.kind === "ready" ? updated.notes : []));
      setSavedMessage("Note removed");
    } catch (cause: unknown) {
      setError(noteErrorMessage(cause, "Could not remove this project note."));
    } finally {
      setSaving(false);
    }
  };

  const handleMarkReviewed = async () => {
    if (!canMarkReviewed || selectedNote === undefined || source.markReviewed === undefined) return;
    setSaving(true);
    setError("");
    setSavedMessage("");
    try {
      const updated = await source.markReviewed({ workspaceId, blockId: selectedNote.blockId });
      onSnapshot(updated);
      setSavedMessage("Marked reviewed — fingerprint updated");
    } catch (cause: unknown) {
      setError(noteErrorMessage(cause, "Could not mark this note as reviewed."));
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveStale = async () => {
    if (staleCount === 0 || saving || committing || snapshot.kind !== "ready" || source.removeStale === undefined) {
      return;
    }
    const noun = staleCount === 1 ? "stale note" : "stale notes";
    const selectedWillGo = selectedNote?.stale === true && editor.kind === "saved";
    if (isDirty && selectedWillGo) {
      if (!window.confirm(`Delete ${staleCount} ${noun} and discard unsaved edits to the selected note?`)) return;
    } else if (!window.confirm(`Delete ${staleCount} ${noun}? Current notes are kept.`)) {
      return;
    }
    setSaving(true);
    setError("");
    setSavedMessage("");
    try {
      const updated = await source.removeStale({ workspaceId });
      onSnapshot(updated);
      const remaining = updated.kind === "ready" ? updated.notes : [];
      const remainingIds = new Set(remaining.map((note) => note.blockId));
      // Keep new-note and surviving saved-note drafts; only leave a deleted stale note.
      if (shouldResetEditorAfterStaleRemoval(editor, remainingIds)) {
        setEditor(noteEditorForBlock(currentBlockId ?? "", remaining));
      }
      setSavedMessage(staleCount === 1 ? "Deleted 1 stale note" : `Deleted ${staleCount} stale notes`);
    } catch (cause: unknown) {
      setError(noteErrorMessage(cause, "Could not delete stale project notes."));
    } finally {
      setSaving(false);
    }
  };

  const handleNewNote = () => {
    if (currentBlockId === null) return;
    const existing = notes.find((note) => note.blockId === currentBlockId);
    chooseEditor(existing === undefined
      ? { kind: "new", blockId: currentBlockId, text: "" }
      : { kind: "saved", blockId: existing.blockId, text: existing.text });
  };

  return (
    <div className="project-notes-backdrop">
      <section ref={dialogRef} className="project-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="project-notes-title">
        <header className="project-notes-header">
          <div className="project-notes-heading">
            <span className="notes-dialog-icon"><FileText size={17} /></span>
            <div>
              <h2 id="project-notes-title">Project notes</h2>
              <p>{snapshot.kind === "ready" ? `${snapshot.notes.length} saved` : "Notes unavailable"} · kept with this workspace</p>
            </div>
          </div>
          <button className="notes-icon-button" type="button" aria-label="Close project notes" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="project-notes-content">
          <aside className="project-notes-list-panel">
            <div className="project-notes-list-heading">
              <span>WORKSPACE NOTES</span>
              <div className="project-notes-list-actions">
                {staleActionsEnabled && staleCount > 0 && (
                  <button
                    className="notes-bulk-remove-button"
                    type="button"
                    onClick={() => { void handleRemoveStale(); }}
                    disabled={saving || committing || snapshot.kind === "error"}
                  >
                    <Trash2 size={13} /> Delete stale ({staleCount})
                  </button>
                )}
                <button className="notes-new-button" type="button" onClick={handleNewNote} disabled={currentBlockId === null || snapshot.kind === "error"}>
                  <Plus size={13} /> New
                </button>
              </div>
            </div>
            <div className="project-notes-list" aria-label="Saved project notes">
              {snapshot.kind === "error" ? (
                <div className="notes-list-message">Notes could not be read from this workspace.</div>
              ) : notes.length === 0 ? (
                <div className="notes-list-message notes-empty-state">
                  <span>No notes yet.</span>
                  {currentBlockId === null || currentBlockId.length === 0
                    ? <span>Select a block on the map, then choose Add note or right-click it.</span>
                    : (
                      <button className="notes-empty-add-button" type="button" onClick={() => textareaRef.current?.focus()}>
                        <Plus size={13} /> Add note to {map.blockById.get(currentBlockId)?.label ?? currentBlockId}
                      </button>
                    )}
                </div>
              ) : notes.map((note) => (
                <button
                  className={`project-note-row${note.blockId === editor.blockId ? " selected" : ""}`}
                  key={note.blockId}
                  type="button"
                  onClick={() => chooseEditor({ kind: "saved", blockId: note.blockId, text: note.text })}
                >
                  <span className="project-note-row-title">{noteLabel(note, map)}</span>
                  <span className="project-note-row-preview">{note.text.replaceAll("\n", " ")}</span>
                  <span className={`project-note-badge${note.stale ? " stale" : ""}`}>
                    {note.stale && <CircleAlert size={11} />}
                    {noteStatus(note, map)}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="project-note-editor" aria-label="Note editor">
            <div className="project-note-target">
              <span>{editor.kind === "new" ? "NEW NOTE FOR" : "NOTE FOR"}</span>
              <strong>{editorBlock?.label ?? (editor.blockId.length > 0 ? editor.blockId : "Choose a block from the map")}</strong>
              {onShowOnMap !== undefined && editorBlock !== undefined && (
                <button className="project-note-show-on-map" type="button" onClick={() => onShowOnMap(editor.blockId)}>
                  <MapPin size={12} /> Show on map
                </button>
              )}
              {editorBlock?.sourcePath !== undefined && editorBlock.sourcePath !== null && <code className="project-note-path">{editorBlock.sourcePath}</code>}
              {selectedNote?.stale === true && (
                <span className="project-note-stale-detail">
                  <CircleAlert size={12} /> {noteStatus(selectedNote, map)}.
                  {staleActionsEnabled && editorBlock !== undefined
                    ? " Mark reviewed if the note still matches, or remove it."
                    : " This note is kept until you remove it."}
                </span>
              )}
            </div>

            {snapshot.kind === "error" && <div className="project-notes-error" role="alert">{snapshot.message}</div>}
            <textarea
              ref={textareaRef}
              className="project-note-textarea"
              aria-label="Project note text"
              placeholder="Write a note about this block…"
              value={editor.text}
              disabled={snapshot.kind === "error" || editor.blockId.length === 0 || saving || committing}
              onChange={(event) => { setEditor({ ...editor, text: event.currentTarget.value }); setSavedMessage(""); }}
            />
            {source.git !== undefined && selectedNote !== undefined && editor.kind === "saved" && (
              <NotesGitPanel key={selectedNote.blockId} source={source.git} workspaceId={workspaceId} note={selectedNote} disabled={saving || isDirty} onBusy={setCommitting} />
            )}
            <div className="project-note-footer">
              <div className="project-note-feedback" aria-live="polite">
                {error.length > 0 ? <span className="project-notes-error" role="alert">{error}</span> : savedMessage}
              </div>
              {editor.kind === "saved" && (
                <button className="notes-remove-button" type="button" onClick={handleRemove} disabled={saving || committing || snapshot.kind === "error"}>
                  <Trash2 size={13} /> Remove
                </button>
              )}
              {showMarkReviewed && (
                <button className="notes-review-button" type="button" onClick={() => { void handleMarkReviewed(); }} disabled={!canMarkReviewed}>
                  <CheckCheck size={13} /> Mark reviewed
                </button>
              )}
              <button className="notes-save-button" type="button" onClick={handleSave} disabled={!canSave}>
                <Save size={13} />{saving ? "Saving…" : editor.kind === "new" ? "Save note" : "Save changes"}
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
