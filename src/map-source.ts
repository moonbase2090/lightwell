export interface MapSourceEntry {
  readonly id: string;
  readonly label: string;
}

export interface MapSourceDocument {
  readonly facts: unknown;
  readonly annotations: unknown;
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
}
