import type { LanguagePack } from "./language-pack.js";
import { registerRustHighlighter } from "./highlighters/rust.js";
import { registerTomlHighlighter } from "./highlighters/toml.js";

/**
 * Built-in language packs shipped with Lightwell. A future plugin loader merges
 * additional packs into the active registry using the same `LanguagePack` shape.
 */
export const BUILTIN_LANGUAGE_PACKS: readonly LanguagePack[] = [
  {
    id: "rust",
    extensions: [".rs"],
    monacoLanguageId: "rust",
    extractor: { kind: "rust-core" },
    registerHighlighter: registerRustHighlighter,
    fixtures: { root: "crates/lightwell-core/fixtures" },
  },
  {
    id: "toml",
    extensions: [".toml"],
    monacoLanguageId: "toml",
    extractor: null,
    registerHighlighter: registerTomlHighlighter,
    fixtures: null,
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    monacoLanguageId: "typescript",
    extractor: { kind: "typescript-module", moduleId: "extract/typescript-modules" },
    registerHighlighter: null,
    fixtures: null,
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    monacoLanguageId: "python",
    extractor: null,
    registerHighlighter: null,
    fixtures: null,
  },
];
