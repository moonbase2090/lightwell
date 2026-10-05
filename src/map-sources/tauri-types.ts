import type {
  MapSourceDocument,
  MapSourceEntry,
  ProjectNoteView,
  ProjectNotesSnapshot,
} from "../map-source.js";

export function parseMapSourceEntry(value: unknown): MapSourceEntry {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("id" in value)
    || typeof value.id !== "string"
    || !("label" in value)
    || typeof value.label !== "string"
  ) {
    throw new Error("The desktop app returned an invalid workspace entry.");
  }

  return { id: value.id, label: value.label };
}

export function parseMapSourceEntries(value: unknown): readonly MapSourceEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("The desktop app returned an invalid recent workspaces list.");
  }

  return value.map((entry: unknown) => parseMapSourceEntry(entry));
}

export function parseMapSourceDocument(value: unknown): MapSourceDocument {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("facts" in value)
    || !("annotations" in value)
  ) {
    throw new Error("The desktop app returned an invalid workspace map.");
  }

  if (!("projectNotes" in value)) {
    return { facts: value.facts, annotations: value.annotations };
  }

  return {
    facts: value.facts,
    annotations: value.annotations,
    projectNotes: parseProjectNotesSnapshot(value.projectNotes),
  };
}

function parseProjectNoteView(value: unknown): ProjectNoteView {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("blockId" in value)
    || typeof value.blockId !== "string"
    || value.blockId.length === 0
    || !("text" in value)
    || typeof value.text !== "string"
    || value.text.trim().length === 0
    || !("sourceFingerprint" in value)
    || typeof value.sourceFingerprint !== "string"
    || value.sourceFingerprint.length === 0
    || !("stale" in value)
    || typeof value.stale !== "boolean"
  ) {
    throw new Error("The desktop app returned an invalid project note.");
  }

  return {
    blockId: value.blockId,
    text: value.text,
    sourceFingerprint: value.sourceFingerprint,
    stale: value.stale,
  };
}

export function parseProjectNotesSnapshot(value: unknown): ProjectNotesSnapshot {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("kind" in value)
    || typeof value.kind !== "string"
  ) {
    throw new Error("The desktop app returned an invalid project notes response.");
  }

  if (value.kind === "ready" && "notes" in value && Array.isArray(value.notes)) {
    return { kind: "ready", notes: value.notes.map(parseProjectNoteView) };
  }
  if (value.kind === "error" && "message" in value && typeof value.message === "string") {
    return { kind: "error", message: value.message };
  }

  throw new Error("The desktop app returned an invalid project notes response.");
}

export function parseWorkspaceMapUpdate(value: unknown): {
  readonly workspaceId: string;
  readonly document: MapSourceDocument;
} {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("workspaceId" in value)
    || typeof value.workspaceId !== "string"
    || !("document" in value)
  ) {
    throw new Error("The desktop app returned an invalid workspace map update.");
  }

  return {
    workspaceId: value.workspaceId,
    document: parseMapSourceDocument(value.document),
  };
}
