import type * as Monaco from "monaco-editor-core";
import type { FactMap } from "../model.js";

export type LanguagePackId = "rust" | "toml" | "typescript" | "python";

export interface WorkspaceExtractArgs {
  readonly repositoryPath: string;
  readonly projectName?: string;
}

export type WorkspaceExtractor = (args: WorkspaceExtractArgs) => FactMap;

/** How map extraction is implemented for a pack (plugin loader will register the same shape). */
export type LanguagePackExtractor =
  | {
      readonly kind: "rust-workspace";
      readonly cargoMapModule: "extract/cargo";
      readonly moduleTreeModule: "extract/rust-modules";
      readonly coreSourceModule: "lightwell_core::rust_source";
    }
  | { readonly kind: "typescript-module"; readonly moduleId: string };

export interface LanguagePackFixtures {
  /** Repository-relative directory holding golden inputs for this pack. */
  readonly root: string;
}

export type MonacoHighlighterRegistrar = (monaco: typeof Monaco) => void;

/**
 * One installable language surface: file extensions, extraction, inspector highlighting, and tests.
 * Built-in packs ship in `builtin-packs.ts`; a future loader appends plugin packs to the same list.
 */
export interface LanguagePack {
  readonly id: LanguagePackId;
  readonly extensions: readonly string[];
  readonly monacoLanguageId: string;
  /** Describes source parsing modules; null until a pack extracts map facts. */
  readonly extractor: LanguagePackExtractor | null;
  /**
   * Whole-workspace extraction (Cargo maps today). Null for highlight-only packs such as TOML.
   * Plugin packs register the same callback shape as built-ins.
   */
  readonly workspaceExtractor: WorkspaceExtractor | null;
  /** Monarch or other Monaco registration; null when Monaco ships a default tokenizer. */
  readonly registerHighlighter: MonacoHighlighterRegistrar | null;
  /** Null until pack-specific fixtures exist under the repo. */
  readonly fixtures: LanguagePackFixtures | null;
}
