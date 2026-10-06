import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, FileText, Plus, Save, Trash2, X } from "lucide-react";
import type { ResolvedMap } from "./model.js";
import type { ProjectNoteView, ProjectNotesSnapshot, ProjectNotesSource } from "./map-source.js";

type NoteEditor =
  | { readonly kind: "new"; readonly blockId: string; readonly text: string }
  | { readonly kind: "saved"; readonly blockId: string; readonly text: string };

interface ProjectNotesDialogProps {
  readonly workspaceId: string;
  readonly source: ProjectNotesSource;
  readonly snapshot: ProjectNotesSnapshot;
  readonly map: ResolvedMap;
  readonly currentBlockId: string | null;
  readonly onSnapshot: (snapshot: ProjectNotesSnapshot) => void;
  readonly onClose: () => void;
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

export default function ProjectNotesDialog({
  workspaceId,
  source,
  snapshot,
  map,
  currentBlockId,
  onSnapshot,
  onClose,
}: ProjectNotesDialogProps) {
  const notes = useMemo(() => snapshot.kind === "ready"
    ? [...snapshot.notes].sort((left, right) => Number(left.stale) - Number(right.stale)
      || left.blockId.localeCompare(right.blockId))
    : [], [snapshot]);
  const [editor, setEditor] = useState<NoteEditor>(() => noteEditorForBlock(currentBlockId ?? "", notes));
  const [saving, setSaving] = useState(false);
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
  const canSave = snapshot.kind === "ready"
    && !saving
    && editor.blockId.length > 0
    && editor.text.trim().length > 0;

  const chooseEditor = (next: NoteEditor) => {
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

  const handleRemove = async () => {
    if (editor.kind !== "saved" || saving) return;
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
              <button className="notes-new-button" type="button" onClick={handleNewNote} disabled={currentBlockId === null || snapshot.kind === "error"}>
                <Plus size={13} /> New
              </button>
            </div>
            <div className="project-notes-list" aria-label="Saved project notes">
              {snapshot.kind === "error" ? (
                <div className="notes-list-message">Notes could not be read from this workspace.</div>
              ) : notes.length === 0 ? (
                <div className="notes-list-message">No notes yet. Select a block and add a note.</div>
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
              {selectedNote?.stale === true && (
                <span className="project-note-stale-detail">
                  <CircleAlert size={12} /> {noteStatus(selectedNote, map)}. This note is kept until you remove it.
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
              disabled={snapshot.kind === "error" || editor.blockId.length === 0 || saving}
              onChange={(event) => { setEditor({ ...editor, text: event.currentTarget.value }); setSavedMessage(""); }}
            />
            <div className="project-note-footer">
              <div className="project-note-feedback" aria-live="polite">
                {error.length > 0 ? <span className="project-notes-error" role="alert">{error}</span> : savedMessage}
              </div>
              {editor.kind === "saved" && (
                <button className="notes-remove-button" type="button" onClick={handleRemove} disabled={saving || snapshot.kind === "error"}>
                  <Trash2 size={13} /> Remove
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
