import type * as Monaco from "monaco-editor-core";

export type LanguagePackId = "rust" | "toml" | "typescript" | "python";

/** How map extraction is implemented for a pack (plugin loader will register the same shape). */
export type LanguagePackExtractor =
  | { readonly kind: "rust-core" }
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
  /** Null until extraction for this pack is wired; built-in packs are always-on when present. */
  readonly extractor: LanguagePackExtractor | null;
  /** Monarch or other Monaco registration; null when Monaco ships a default tokenizer. */
  readonly registerHighlighter: MonacoHighlighterRegistrar | null;
  /** Null until pack-specific fixtures exist under the repo. */
  readonly fixtures: LanguagePackFixtures | null;
}
