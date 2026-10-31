export type LanguagePackOrigin = "builtin" | "user" | "workspace";
export type LanguagePackErrorCode = "read" | "parse" | "validation" | "conflict" | "unknown-hook";

export interface LanguagePackManifestSummary {
  readonly extensions: readonly string[];
  readonly basenames: readonly string[];
  readonly basenamePrefixes: readonly string[];
}

export interface LoadedLanguagePackEntry {
  readonly kind: "loaded";
  readonly id: string;
  readonly packVersion: string;
  readonly origin: LanguagePackOrigin;
  readonly manifestPath: string | null;
  readonly manifest: LanguagePackManifestSummary;
}

export interface InvalidLanguagePackEntry {
  readonly kind: "error";
  readonly errorId: string;
  readonly origin: Exclude<LanguagePackOrigin, "builtin">;
  readonly manifestPath: string;
  readonly code: LanguagePackErrorCode;
  readonly message: string;
}

export type LanguagePackEntry = LoadedLanguagePackEntry | InvalidLanguagePackEntry;

export interface LanguagePackCatalogSnapshot {
  readonly revision: number;
  readonly userPacksDirectory: string;
  readonly entries: readonly LanguagePackEntry[];
}

export type LanguagePackInstallSource =
  | { readonly kind: "catalog"; readonly id: string }
  | { readonly kind: "path"; readonly path: string };

export interface LanguagePackSource {
  catalog(workspaceId: string | null): Promise<LanguagePackCatalogSnapshot>;
  install(source: LanguagePackInstallSource, replace: boolean): Promise<LanguagePackCatalogSnapshot>;
  reload(workspaceId: string | null): Promise<LanguagePackCatalogSnapshot>;
  remove(id: string): Promise<LanguagePackCatalogSnapshot>;
  openDirectory(): Promise<void>;
  watch(
    onChange: (catalog: LanguagePackCatalogSnapshot) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void>;
}
