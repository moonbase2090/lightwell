import type { LanguagePack } from "../language-pack.js";

/** Manifest highlighting for Rust workspaces; Monarch registration is owned by the Rust pack. */
export const TOML_LANGUAGE_PACK: LanguagePack = {
  id: "toml",
  extensions: [".toml"],
  monacoLanguageId: "toml",
  extractor: null,
  workspaceExtractor: null,
  registerHighlighter: null,
  fixtures: null,
};
