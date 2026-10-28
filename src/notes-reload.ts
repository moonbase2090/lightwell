import type {
  NoteConflictCurrent,
  NoteRevisionConflict,
  NoteWriteExpectationMode,
  ProjectNoteView,
} from "./map-source.js";

/** SHA-256 hex of `text`, one NUL byte, then `sourceFingerprint`. Matches the Rust `note_revision`. */
export async function noteRevision(text: string, sourceFingerprint: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${text}\0${sourceFingerprint}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface NotesEditorBase {
  readonly kind: "new" | "saved";
  readonly blockId: string;
  readonly text: string;
  readonly loadedText: string;
}

export type NotesReloadPlan =
  | { readonly kind: "ignore" }
  | { readonly kind: "pin" }
  | {
      readonly kind: "adopt";
      readonly editorKind: "new" | "saved";
      readonly blockId: string;
      readonly text: string;
      readonly loadedText: string;
      readonly loadedRevision: string | null;
      readonly notice: string | null;
    };

export function noteRevisionMap(notes: readonly Pick<ProjectNoteView, "blockId" | "revision">[]): Map<string, string> {
  return new Map(notes.map((note) => [note.blockId, note.revision ?? ""]));
}

function sameRevisionMap(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [blockId, revision] of left) {
    if (right.get(blockId) !== revision) return false;
  }
  return true;
}

/**
 * How an open editor should treat a notes snapshot from disk.
 * Clean editors adopt it. Dirty editors keep their buffer. A snapshot whose
 * revisions match the last applied save is an echo and is ignored.
 */
export function planNotesReload(
  editor: NotesEditorBase,
  incoming: readonly ProjectNoteView[],
  lastApplied: ReadonlyMap<string, string> | null,
): NotesReloadPlan {
  const incomingRevisions = noteRevisionMap(incoming);
  if (lastApplied !== null && sameRevisionMap(lastApplied, incomingRevisions)) {
    return { kind: "ignore" };
  }
  const clean = editor.kind === "new" ? editor.text.length === 0 : editor.text === editor.loadedText;
  if (!clean) return { kind: "pin" };
  const selected = incoming.find((note) => note.blockId === editor.blockId);
  if (selected === undefined) {
    return {
      kind: "adopt",
      editorKind: "new",
      blockId: editor.blockId,
      text: "",
      loadedText: "",
      loadedRevision: null,
      notice: editor.kind === "saved" ? "This note was removed on disk." : null,
    };
  }
  return {
    kind: "adopt",
    editorKind: "saved",
    blockId: selected.blockId,
    text: selected.text,
    loadedText: selected.text,
    loadedRevision: selected.revision ?? null,
    notice: null,
  };
}

export function readNoteRevisionConflict(cause: unknown): NoteRevisionConflict | null {
  if (typeof cause !== "object" || cause === null) return null;
  if (!("kind" in cause) || cause.kind !== "revisionConflict") return null;
  if (!("blockId" in cause) || typeof cause.blockId !== "string" || cause.blockId.length === 0) return null;
  if (!("current" in cause)) return null;
  const current = readConflictCurrent(cause.current);
  if (current === null) return null;
  return { kind: "revisionConflict", blockId: cause.blockId, current };
}

function readConflictCurrent(value: unknown): NoteConflictCurrent | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  if (value.kind === "deleted") return { kind: "deleted" };
  if (value.kind !== "present") return null;
  if (!("text" in value) || typeof value.text !== "string") return null;
  if (!("sourceFingerprint" in value) || typeof value.sourceFingerprint !== "string" || value.sourceFingerprint.length === 0) {
    return null;
  }
  if (!("revision" in value) || typeof value.revision !== "string" || value.revision.length === 0) return null;
  return {
    kind: "present",
    text: value.text,
    sourceFingerprint: value.sourceFingerprint,
    revision: value.revision,
  };
}

export interface MemoryNote {
  readonly text: string;
  readonly sourceFingerprint: string;
  readonly revision: string;
}

export type MemoryNoteWrite =
  | { readonly ok: true; readonly note: MemoryNote }
  | { readonly ok: false; readonly conflict: NoteRevisionConflict };

export async function applyMemoryNoteWrite(
  blockId: string,
  existing: MemoryNote | undefined,
  text: string,
  sourceFingerprint: string,
  expectation: NoteWriteExpectationMode | undefined,
  expectedRevision: string | null | undefined,
): Promise<MemoryNoteWrite> {
  if (expectation === "absent" && existing !== undefined) {
    return { ok: false, conflict: presentConflict(blockId, existing) };
  }
  if (expectation === "matchesRevision") {
    if (existing === undefined) {
      return { ok: false, conflict: { kind: "revisionConflict", blockId, current: { kind: "deleted" } } };
    }
    if (existing.revision !== (expectedRevision ?? "")) {
      return { ok: false, conflict: presentConflict(blockId, existing) };
    }
  }
  return {
    ok: true,
    note: {
      text,
      sourceFingerprint,
      revision: await noteRevision(text, sourceFingerprint),
    },
  };
}

function presentConflict(blockId: string, note: MemoryNote): NoteRevisionConflict {
  return {
    kind: "revisionConflict",
    blockId,
    current: {
      kind: "present",
      text: note.text,
      sourceFingerprint: note.sourceFingerprint,
      revision: note.revision,
    },
  };
}
