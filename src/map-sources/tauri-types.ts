import type {
  BlockDiffDocument,
  CommitBlockChange,
  CommitChanges,
  CommitConnectionChange,
  ConnectionChangeState,
  CommitFileChange,
  CommitSummary,
  EditorSettings,
  EditorTemplatePreset,
  MapSourceDocument,
  MapSourceEntry,
  ProjectNoteView,
  NotesGitStatus,
  NoteCommitResult,
  ProjectNotesSnapshot,
  SourceFileDocument,
} from "../map-source.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMapSourceEntry(value: unknown): MapSourceEntry {
  if (
    !isRecord(value)
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
    !isRecord(value)
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
    !isRecord(value)
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

export function parseSourceFileDocument(value: unknown): SourceFileDocument {
  if (
    !isRecord(value)
    || typeof value.path !== "string"
    || typeof value.content !== "string"
    || !Number.isInteger(value.line)
    || typeof value.line !== "number"
    || value.line < 1
    || !Number.isInteger(value.column)
    || typeof value.column !== "number"
    || value.column < 1
  ) {
    throw new Error("The desktop app returned an invalid source file.");
  }

  return {
    path: value.path,
    content: value.content,
    line: value.line,
    column: value.column,
  };
}

export function parseEditorSettings(value: unknown): EditorSettings {
  if (
    !isRecord(value)
    || !(value.commandTemplate === null || typeof value.commandTemplate === "string")
  ) {
    throw new Error("The desktop app returned invalid editor settings.");
  }

  return { commandTemplate: value.commandTemplate };
}

export function parseEditorTemplatePresets(value: unknown): readonly EditorTemplatePreset[] {
  if (!Array.isArray(value)) {
    throw new Error("The desktop app returned invalid editor presets.");
  }

  return value.map((preset: unknown) => {
    if (
      !isRecord(preset)
      || typeof preset.name !== "string"
      || typeof preset.template !== "string"
    ) {
      throw new Error("The desktop app returned an invalid editor preset.");
    }
    return { name: preset.name, template: preset.template };
  });
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseCommitSummary(value: unknown): CommitSummary {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.shortId !== "string"
    || typeof value.summary !== "string"
    || typeof value.timestamp !== "number"
  ) {
    throw new Error("The desktop app returned an invalid commit.");
  }
  return { id: value.id, shortId: value.shortId, summary: value.summary, timestamp: value.timestamp };
}

export function parseCommitSummaries(value: unknown): readonly CommitSummary[] {
  if (!Array.isArray(value)) throw new Error("The desktop app returned an invalid commit list.");
  return value.map(parseCommitSummary);
}

function parseConnectionChangeState(value: unknown): ConnectionChangeState {
  if (value === "added" || value === "removed" || value === "changed") return value;
  throw new Error("The desktop app returned an invalid connection change.");
}

function parseConnectionChange(value: unknown): CommitConnectionChange {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.source !== "string"
    || typeof value.target !== "string"
    || (value.kind !== "contains" && value.kind !== "depends_on")
  ) {
    throw new Error("The desktop app returned an invalid connection change.");
  }
  return {
    id: value.id,
    source: value.source,
    target: value.target,
    kind: value.kind,
    state: parseConnectionChangeState(value.state),
  };
}

export function parseCommitChanges(value: unknown): CommitChanges {
  if (
    !isRecord(value)
    || !Array.isArray(value.files)
    || !Array.isArray(value.blocks)
    || !Array.isArray(value.connections)
  ) {
    throw new Error("The desktop app returned invalid commit changes.");
  }
  const files = value.files.map((file: unknown): CommitFileChange => {
    if (
      !isRecord(file)
      || typeof file.path !== "string"
      || !(file.oldPath === null || file.oldPath === undefined || typeof file.oldPath === "string")
      || !isCount(file.added)
      || !isCount(file.removed)
      || typeof file.binary !== "boolean"
    ) {
      throw new Error("The desktop app returned an invalid changed file.");
    }
    return { path: file.path, oldPath: typeof file.oldPath === "string" ? file.oldPath : null, added: file.added, removed: file.removed, binary: file.binary };
  });
  const blocks = value.blocks.map((block: unknown): CommitBlockChange => {
    if (!isRecord(block) || typeof block.blockId !== "string" || !isCount(block.added) || !isCount(block.removed)
      || typeof block.label !== "string"
      || !(block.sourcePath === null || typeof block.sourcePath === "string")
      || !(block.parentId === null || typeof block.parentId === "string")
      || !(block.state === "added" || block.state === "changed" || block.state === "removed")) {
      throw new Error("The desktop app returned an invalid changed block.");
    }
    return { blockId: block.blockId, label: block.label, sourcePath: block.sourcePath, parentId: block.parentId, state: block.state, added: block.added, removed: block.removed };
  });
  const connections = value.connections.map(parseConnectionChange);
  const baseCommit = value.baseCommit === null || value.baseCommit === undefined
    ? null
    : parseCommitSummary(value.baseCommit);
  return { baseCommit, commit: parseCommitSummary(value.commit), files, blocks, connections };
}

export function parseBlockDiffDocument(value: unknown): BlockDiffDocument {
  if (
    !isRecord(value)
    || typeof value.path !== "string"
    || !(value.originalPath === null || value.originalPath === undefined || typeof value.originalPath === "string")
    || typeof value.original !== "string"
    || typeof value.modified !== "string"
    || typeof value.line !== "number"
    || !Number.isInteger(value.line)
    || value.line < 1
    || !(value.originalLine === null || (typeof value.originalLine === "number" && Number.isInteger(value.originalLine) && value.originalLine >= 1))
  ) {
    throw new Error("The desktop app returned an invalid commit diff.");
  }
  return {
    commit: parseCommitSummary(value.commit),
    path: value.path,
    originalPath: typeof value.originalPath === "string" ? value.originalPath : null,
    original: value.original,
    modified: value.modified,
    line: value.line,
    originalLine: value.originalLine,
  };
}

export function parseNotesGitStatus(value: unknown): NotesGitStatus {
  if (isRecord(value)) {
    if (value.kind === "notRepository" || value.kind === "missing" || value.kind === "ignored" || value.kind === "conflicted") {
      return { kind: value.kind };
    }
    if (value.kind === "unavailable" && typeof value.message === "string") {
      return { kind: "unavailable", message: value.message };
    }
    if (value.kind === "ready" && typeof value.revision === "string" && value.revision.length > 0 && typeof value.noteChanged === "boolean"
      && (value.state === "clean" || value.state === "untracked" || value.state === "modified" || value.state === "staged" || value.state === "mixed")) {
      return { kind: "ready", state: value.state, revision: value.revision, noteChanged: value.noteChanged };
    }
  }
  throw new Error("The desktop app returned an invalid notes Git status.");
}

export function parseNoteCommitResult(value: unknown): NoteCommitResult {
  if (!isRecord(value) || !(value.commitId === null || (typeof value.commitId === "string" && /^[0-9a-f]{40,64}$/.test(value.commitId)))) {
    throw new Error("The desktop app returned an invalid note commit response.");
  }
  return { commitId: value.commitId, status: parseNotesGitStatus(value.status) };
}
