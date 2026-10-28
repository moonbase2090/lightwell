export interface MapSourceEntry {
  readonly id: string;
  readonly label: string;
}

export interface ProjectNoteView {
  readonly blockId: string;
  readonly text: string;
  readonly sourceFingerprint: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly stale: boolean;
  /** Present when the snapshot includes a per-note revision. */
  readonly revision?: string;
}

export type NoteWriteExpectationMode = "unconditional" | "absent" | "matchesRevision";

export type NoteConflictCurrent =
  | { readonly kind: "deleted" }
  | { readonly kind: "present"; readonly text: string; readonly sourceFingerprint: string; readonly revision: string };

export interface NoteRevisionConflict {
  readonly kind: "revisionConflict";
  readonly blockId: string;
  readonly current: NoteConflictCurrent;
}

export type ProjectNotesSnapshot =
  | { readonly kind: "ready"; readonly notes: readonly ProjectNoteView[] }
  | { readonly kind: "error"; readonly message: string };

export interface MapSourceDocument {
  readonly facts: unknown;
  readonly annotations: unknown;
  readonly projectNotes?: ProjectNotesSnapshot;
}

export interface ProjectNoteInput {
  readonly workspaceId: string;
  readonly blockId: string;
  readonly text: string;
  readonly expectedRevision?: string | null;
  readonly expectation?: NoteWriteExpectationMode;
}

export type NotesGitStatus =
  | { readonly kind: "notRepository" | "missing" | "ignored" | "conflicted" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "ready"; readonly state: "clean" | "untracked" | "modified" | "staged" | "mixed"; readonly revision: string; readonly noteChanged: boolean };

export interface NoteCommitResult {
  readonly commitId: string | null;
  readonly status: NotesGitStatus;
}

export interface ProjectNotesGitSource {
  status(input: Omit<ProjectNoteInput, "text">): Promise<NotesGitStatus>;
  commit(input: ProjectNoteInput & { readonly revision: string; readonly sourceFingerprint: string }): Promise<NoteCommitResult>;
}

export interface ProjectNotesSource {
  readonly git?: ProjectNotesGitSource;
  add(input: ProjectNoteInput): Promise<ProjectNotesSnapshot>;
  edit(input: ProjectNoteInput): Promise<ProjectNotesSnapshot>;
  remove(input: Omit<ProjectNoteInput, "text">): Promise<ProjectNotesSnapshot>;
  /**
   * Re-fingerprint a note whose text still matches the current block source.
   * Present only when `VITE_ENABLE_NOTES_STALE_ACTIONS=true`.
   */
  markReviewed?(input: Omit<ProjectNoteInput, "text">): Promise<ProjectNotesSnapshot>;
  /**
   * Remove every stale note. Callers must confirm with the user first.
   * Present only when `VITE_ENABLE_NOTES_STALE_ACTIONS=true`.
   */
  removeStale?(input: { readonly workspaceId: string }): Promise<ProjectNotesSnapshot>;
}

export interface SourceFileDocument {
  readonly path: string;
  readonly content: string;
  readonly line: number;
  readonly column: number;
}

export interface EditorSettings {
  readonly commandTemplate: string | null;
}

export interface EditorTemplatePreset {
  readonly name: string;
  readonly template: string;
}

export interface MapEditorSource {
  inspectBlock(workspaceId: string, blockId: string): Promise<SourceFileDocument>;
  openBlock(workspaceId: string, blockId: string): Promise<void>;
  loadSettings(): Promise<EditorSettings>;
  saveSettings(settings: EditorSettings): Promise<EditorSettings>;
  listPresets(): Promise<readonly EditorTemplatePreset[]>;
}

export interface CommitSummary {
  readonly id: string;
  readonly shortId: string;
  readonly summary: string;
  /** Committer time, Unix seconds. */
  readonly timestamp: number;
}

export interface CommitFileChange {
  readonly path: string;
  readonly oldPath: string | null;
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
}

export interface CommitBlockChange {
  readonly blockId: string;
  readonly label: string;
  readonly sourcePath: string | null;
  readonly parentId: string | null;
  readonly state: "added" | "changed" | "removed";
  readonly added: number;
  readonly removed: number;
}

export type ConnectionChangeState = "added" | "removed" | "changed";

export interface CommitConnectionChange {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "contains" | "depends_on";
  readonly state: ConnectionChangeState;
}

export interface CommitChanges {
  /** When set, changes are everything after this commit through `commit`. */
  readonly baseCommit: CommitSummary | null;
  readonly commit: CommitSummary;
  readonly files: readonly CommitFileChange[];
  readonly blocks: readonly CommitBlockChange[];
  readonly connections: readonly CommitConnectionChange[];
}

/** One block's file before and after a commit. */
export interface BlockDiffDocument {
  readonly commit: CommitSummary;
  readonly path: string;
  readonly originalPath: string | null;
  /** Empty when the commit added the file. */
  readonly original: string;
  /** Empty when the commit deleted the file. */
  readonly modified: string;
  /** Line in `modified` to reveal. */
  readonly line: number;
  /** Reveal the original side for a deleted block. */
  readonly originalLine: number | null;
}

export type CommitRangePreset =
  | { readonly kind: "lastCommit" | "lastFive" | "sinceRelease" }
  | { readonly kind: "custom"; readonly from: string | null };

export interface ResolvedCommitRange {
  readonly commit: CommitSummary;
  readonly baseCommit: CommitSummary | null;
  readonly commitCount: number;
  readonly releaseTag: string | null;
}

/** Git history for the commit diff view. */
export interface MapHistorySource {
  resolveRange(workspaceId: string, through: string, preset: CommitRangePreset): Promise<ResolvedCommitRange>;
  listCommits(workspaceId: string): Promise<readonly CommitSummary[]>;
  listSinceCommits(workspaceId: string, throughCommitId: string): Promise<readonly CommitSummary[]>;
  commitChanges(workspaceId: string, commitId: string, baseCommitId?: string | null): Promise<CommitChanges>;
  blockDiff(workspaceId: string, commitId: string, blockId: string, baseCommitId?: string | null): Promise<BlockDiffDocument>;
  fileDiff(workspaceId: string, commitId: string, filePath: string, baseCommitId?: string | null): Promise<BlockDiffDocument>;
}

export interface MapSource {
  listMaps(): Promise<readonly MapSourceEntry[]>;
  loadMap(id: string): Promise<MapSourceDocument>;
  openWorkspace?(): Promise<MapSourceEntry | null>;
  watchMap?(
    id: string,
    onChange: (document: MapSourceDocument) => void,
    onError: (error: unknown) => void,
    onNotes?: (snapshot: ProjectNotesSnapshot) => void,
  ): Promise<() => void>;
  readonly projectNotes?: ProjectNotesSource;
  readonly editor?: MapEditorSource;
  /** Present only when the commit diff view is enabled. */
  readonly history?: MapHistorySource;
}
