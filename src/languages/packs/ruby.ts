import type { LanguagePack } from "../language-pack.js";
import { registerRubyHighlighter } from "../highlighters/ruby.js";

/** Ruby facts are appended by the Rust workspace extractor (`extractCargoMap`). */
export const RUBY_LANGUAGE_PACK: LanguagePack = {
  id: "ruby",
  extensions: [".rb"],
  monacoLanguageId: "ruby",
  extractor: {
    kind: "ruby-module",
    moduleId: "extract/ruby-modules",
    coreSourceModule: "lightwell_core::ruby_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerRubyHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/ruby-sample" },
};
