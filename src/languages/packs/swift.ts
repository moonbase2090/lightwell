import type { LanguagePack } from "../language-pack.js";
import { registerSwiftHighlighter } from "../highlighters/swift.js";

/** Swift facts are appended by the Rust workspace extractor (`extractCargoMap`). */
export const SWIFT_LANGUAGE_PACK: LanguagePack = {
  id: "swift",
  extensions: [".swift"],
  monacoLanguageId: "swift",
  extractor: {
    kind: "swift-module",
    moduleId: "extract/swift-modules",
    coreSourceModule: "lightwell_core::swift_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerSwiftHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/swift-sample" },
};
