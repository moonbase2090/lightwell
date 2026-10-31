import type { LanguagePack } from "../language-pack.js";
import { registerCppHighlighter } from "../highlighters/cpp.js";

/** C/C++ facts are appended by the Rust workspace extractor (`extractCargoMap`). */
export const CPP_LANGUAGE_PACK: LanguagePack = {
  id: "cpp",
  packVersion: "1.0.0",
  extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
  monacoLanguageId: "cpp",
  extractor: {
    kind: "cpp-module",
    moduleId: "extract/cpp-modules",
    coreSourceModule: "lightwell_core::cpp_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerCppHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/cpp-sample" },
};
