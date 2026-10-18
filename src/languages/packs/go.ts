import type { LanguagePack } from "../language-pack.js";
import { registerGoHighlighter } from "../highlighters/go.js";

/** Go facts are appended by the Rust workspace extractor (`extractCargoMap`). */
export const GO_LANGUAGE_PACK: LanguagePack = {
  id: "go",
  extensions: [".go"],
  monacoLanguageId: "go",
  extractor: {
    kind: "go-module",
    moduleId: "extract/go-modules",
    coreSourceModule: "lightwell_core::go_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerGoHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/go-sample" },
};
