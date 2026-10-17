export interface MapSourceEntry {
  readonly id: string;
  readonly label: string;
}

export interface ProjectNoteView {
  readonly blockId: string;
  readonly text: string;
  readonly sourceFingerprint: string;
  readonly stale: boolean;
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
}

export interface ProjectNotesSource {
  add(input: ProjectNoteInput): Promise<ProjectNotesSnapshot>;
  edit(input: ProjectNoteInput): Promise<ProjectNotesSnapshot>;
  remove(input: Omit<ProjectNoteInput, "text">): Promise<ProjectNotesSnapshot>;
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
}

/** Git history for the commit diff view. */
export interface MapHistorySource {
  listCommits(workspaceId: string): Promise<readonly CommitSummary[]>;
  listSinceCommits(workspaceId: string, throughCommitId: string): Promise<readonly CommitSummary[]>;
  commitChanges(workspaceId: string, commitId: string, baseCommitId?: string | null): Promise<CommitChanges>;
  blockDiff(workspaceId: string, commitId: string, blockId: string, baseCommitId?: string | null): Promise<BlockDiffDocument>;
}

export interface MapSource {
  listMaps(): Promise<readonly MapSourceEntry[]>;
  loadMap(id: string): Promise<MapSourceDocument>;
  openWorkspace?(): Promise<MapSourceEntry | null>;
  watchMap?(
    id: string,
    onChange: (document: MapSourceDocument) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void>;
  readonly projectNotes?: ProjectNotesSource;
  readonly editor?: MapEditorSource;
  /** Present only when the commit diff view is enabled. */
  readonly history?: MapHistorySource;
}
