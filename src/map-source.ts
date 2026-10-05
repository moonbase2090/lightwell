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
}
