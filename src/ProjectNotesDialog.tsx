import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, CircleAlert, FileText, MapPin, Plus, Save, Trash2, X } from "lucide-react";
import type { ResolvedMap } from "./model.js";
import type { NoteRevisionConflict, ProjectNoteInput, ProjectNoteView, ProjectNotesSnapshot, ProjectNotesSource } from "./map-source.js";
import NotesGitPanel from "./NotesGitPanel.js";
import { noteRevisionMap, planNotesReload, readNoteRevisionConflict } from "./notes-reload.js";

type NoteEditor = {
  readonly kind: "new" | "saved";
  readonly blockId: string;
  readonly text: string;
  readonly loadedText: string;
  readonly loadedRevision: string | null;
};

function notesCompareAndSwap(): boolean {
  return typeof import.meta.env !== "undefined" && import.meta.env.VITE_ENABLE_NOTES_CAS === "true";
}

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
  /** Reports whether the draft has unsaved text, so the workspace can confirm before closing. */
  readonly onDirtyChange?: (dirty: boolean) => void;
}

function noteEditorForBlock(blockId: string, notes: readonly ProjectNoteView[], initialText = ""): NoteEditor {
  const note = notes.find((item) => item.blockId === blockId);
  return note === undefined
    ? { kind: "new", blockId, text: initialText, loadedText: "", loadedRevision: null }
    : { kind: "saved", blockId, text: note.text, loadedText: note.text, loadedRevision: note.revision ?? null };
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
  onDirtyChange,
}: ProjectNotesDialogProps) {
  const notes = useMemo(() => snapshot.kind === "ready"
    ? [...snapshot.notes].sort((left, right) => Number(left.stale) - Number(right.stale)
      || left.blockId.localeCompare(right.blockId))
    : [], [snapshot]);
  const notesCas = notesCompareAndSwap();
  const [editor, setEditor] = useState<NoteEditor>(() => noteEditorForBlock(currentBlockId ?? "", notes, initialText));
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [diskBanner, setDiskBanner] = useState("");
  const [diskNotice, setDiskNotice] = useState("");
  const [conflict, setConflict] = useState<NoteRevisionConflict | null>(null);
  const [gitRefresh, setGitRefresh] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const snapshotSeen = useRef(snapshot);
  const savingCount = useRef(0);
  const pendingSnapshot = useRef<ProjectNotesSnapshot | null>(null);
  const lastAppliedRef = useRef<Map<string, string> | null>(
    snapshot.kind === "ready" ? noteRevisionMap(snapshot.notes) : null,
  );

  const applyExternal = (next: ProjectNotesSnapshot) => {
    if (!notesCas || next.kind !== "ready") return;
    const plan = planNotesReload(editorRef.current, next.notes, lastAppliedRef.current);
    snapshotSeen.current = next;
    if (plan.kind === "ignore") return;
    lastAppliedRef.current = noteRevisionMap(next.notes);
    setGitRefresh((value) => value + 1);
    if (plan.kind === "pin") {
      setDiskBanner("Notes changed on disk.");
      return;
    }
    setDiskBanner("");
    setConflict(null);
    const adopted: NoteEditor = {
      kind: plan.editorKind,
      blockId: plan.blockId,
      text: plan.text,
      loadedText: plan.loadedText,
      loadedRevision: plan.loadedRevision,
    };
    editorRef.current = adopted;
    setEditor(adopted);
    setSavedMessage("");
    setError("");
    setDiskNotice(plan.notice ?? "");
  };

  useEffect(() => {
    if (!notesCas) return;
    if (snapshot === snapshotSeen.current) return;
    if (savingCount.current > 0) {
      pendingSnapshot.current = snapshot;
      return;
    }
    applyExternal(snapshot);
  }, [snapshot, notesCas]);

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
  const isDirty = notesCas
    ? (editor.kind === "new" ? editor.text.length > 0 : editor.text !== editor.loadedText)
    : editor.kind === "new"
      ? editor.text.length > 0
      : selectedNote === undefined || selectedNote.text !== editor.text;
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
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
    editorRef.current = next;
    setEditor(next);
    setError("");
    setSavedMessage("");
    setDiskBanner("");
    setDiskNotice("");
    setConflict(null);
  };

  const finishSave = (updated: ProjectNotesSnapshot, draft: string) => {
    onSnapshot(updated);
    const saved = updated.kind === "ready" ? updated.notes.find((note) => note.blockId === editor.blockId) : undefined;
    const next: NoteEditor = {
      kind: "saved",
      blockId: editor.blockId,
      text: draft,
      loadedText: saved?.text ?? draft,
      loadedRevision: saved?.revision ?? null,
    };
    if (notesCas && updated.kind === "ready") {
      lastAppliedRef.current = noteRevisionMap(updated.notes);
      snapshotSeen.current = updated;
    }
    editorRef.current = next;
    setEditor(next);
    setConflict(null);
    setDiskBanner("");
    setDiskNotice("");
    setSavedMessage("Saved in .lightwell/notes.json");
  };

  const writeNote = async (input: ProjectNoteInput, useAdd: boolean) => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    setSavedMessage("");
    savingCount.current += 1;
    try {
      const updated = useAdd ? await source.add(input) : await source.edit(input);
      finishSave(updated, input.text);
    } catch (cause: unknown) {
      const found = notesCas ? readNoteRevisionConflict(cause) : null;
      if (found !== null) {
        setConflict(found);
        setError("");
      } else {
        setError(noteErrorMessage(cause, "Could not save this project note."));
      }
    } finally {
      savingCount.current -= 1;
      const pending = pendingSnapshot.current;
      pendingSnapshot.current = null;
      if (notesCas && pending !== null && savingCount.current === 0) applyExternal(pending);
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const input: ProjectNoteInput = {
      workspaceId,
      blockId: editor.blockId,
      text: editor.text,
      ...(notesCas ? {
        expectedRevision: editor.kind === "saved" ? editor.loadedRevision : null,
        expectation: editor.kind === "saved" ? "matchesRevision" as const : "absent" as const,
      } : {}),
    };
    await writeNote(input, editor.kind === "new");
  };

  const overwriteConflict = async () => {
    if (conflict === null) return;
    const present = conflict.current.kind === "present";
    await writeNote({
      workspaceId,
      blockId: editor.blockId,
      text: editor.text,
      expectedRevision: present ? conflict.current.revision : null,
      expectation: present ? "matchesRevision" : "absent",
    }, !present);
  };

  const discardToDisk = () => {
    if (snapshot.kind !== "ready") return;
    const note = snapshot.notes.find((item) => item.blockId === editor.blockId);
    setConflict(null);
    setDiskBanner("");
    setError("");
    setSavedMessage("");
    if (note === undefined) {
      const next: NoteEditor = { kind: "new", blockId: editor.blockId, text: "", loadedText: "", loadedRevision: null };
      editorRef.current = next;
      setEditor(next);
      setDiskNotice("This note was removed on disk.");
    } else {
      const next: NoteEditor = {
        kind: "saved",
        blockId: note.blockId,
        text: note.text,
        loadedText: note.text,
        loadedRevision: note.revision ?? null,
      };
      editorRef.current = next;
      setEditor(next);
      setDiskNotice("");
    }
    lastAppliedRef.current = noteRevisionMap(snapshot.notes);
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
      if (notesCas && updated.kind === "ready") {
        lastAppliedRef.current = noteRevisionMap(updated.notes);
        snapshotSeen.current = updated;
      }
      const next = noteEditorForBlock(currentBlockId ?? "", updated.kind === "ready" ? updated.notes : []);
      editorRef.current = next;
      setEditor(next);
      setConflict(null);
      setDiskBanner("");
      setDiskNotice("");
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
    chooseEditor(noteEditorForBlock(currentBlockId, notes));
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
                  onClick={() => chooseEditor(noteEditorForBlock(note.blockId, notes))}
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
            {notesCas && diskBanner.length > 0 && (
              <div className="notes-disk-banner" role="status">
                <p>{diskBanner} Your draft is unchanged.</p>
                <div className="notes-disk-banner-actions">
                  <button className="notes-new-button" type="button" onClick={discardToDisk}>Reload</button>
                  <button className="notes-new-button" type="button" onClick={() => setDiskBanner("")}>Dismiss</button>
                </div>
              </div>
            )}
            {notesCas && diskNotice.length > 0 && <p className="project-note-feedback" role="status">{diskNotice}</p>}
            {notesCas && conflict !== null && (
              <div className="notes-conflict" role="alert">
                <p>This note changed on disk. Your draft is still here.</p>
                {conflict.current.kind === "deleted"
                  ? <p>The saved note was removed.</p>
                  : <p className="notes-conflict-disk">{conflict.current.text}</p>}
                <div className="notes-disk-banner-actions">
                  <button className="notes-save-button" type="button" onClick={() => void overwriteConflict()} disabled={saving || committing}>Overwrite</button>
                  <button className="notes-new-button" type="button" onClick={discardToDisk} disabled={saving || committing}>Reload</button>
                  <button className="notes-new-button" type="button" onClick={() => setConflict(null)} disabled={saving || committing}>Cancel</button>
                </div>
              </div>
            )}
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
              <NotesGitPanel
                key={selectedNote.blockId}
                source={source.git}
                workspaceId={workspaceId}
                note={selectedNote}
                disabled={saving || isDirty || (notesCas && (diskBanner.length > 0 || (selectedNote.revision ?? null) !== editor.loadedRevision))}
                disabledReason={notesCas && (selectedNote.revision ?? null) !== editor.loadedRevision ? "Notes changed on disk. Reload this note before committing it." : undefined}
                refreshToken={gitRefresh}
                onBusy={setCommitting}
              />
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
