import type {
  InvalidLanguagePackCatalogEntry,
  LanguagePackCatalog,
  LanguagePackErrorCode as LoaderLanguagePackErrorCode,
  LanguagePackOrigin as LoaderLanguagePackOrigin,
  LoadedLanguagePackCatalogEntry,
} from "./languages/loader.js";

export type LanguagePackOrigin = LoaderLanguagePackOrigin;
export type LanguagePackErrorCode = LoaderLanguagePackErrorCode;

export type LoadedLanguagePackEntry = LoadedLanguagePackCatalogEntry;

export type InvalidLanguagePackEntry = InvalidLanguagePackCatalogEntry;

export type LanguagePackEntry = LoadedLanguagePackEntry | InvalidLanguagePackEntry;

export type LanguagePackCatalogSnapshot = LanguagePackCatalog;

export type LanguagePackInstallSource =
  | { readonly kind: "catalog"; readonly id: string }
  | { readonly kind: "path"; readonly path: string };

export interface LanguagePackSource {
  catalog(workspaceId: string | null): Promise<LanguagePackCatalogSnapshot>;
  install(source: LanguagePackInstallSource, replace: boolean, workspaceId: string | null): Promise<LanguagePackCatalogSnapshot>;
  reload(workspaceId: string | null): Promise<LanguagePackCatalogSnapshot>;
  remove(id: string, workspaceId: string | null): Promise<LanguagePackCatalogSnapshot>;
  openDirectory(): Promise<void>;
  watch(
    onChange: (catalog: LanguagePackCatalogSnapshot) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void>;
}
