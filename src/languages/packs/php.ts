import type { LanguagePack } from "../language-pack.js";
import { registerPhpHighlighter } from "../highlighters/php.js";

/** PHP facts are appended by the Rust workspace extractor (`extractCargoMap`). */
export const PHP_LANGUAGE_PACK: LanguagePack = {
  id: "php",
  extensions: [".php"],
  monacoLanguageId: "php",
  extractor: {
    kind: "php-module",
    moduleId: "extract/php-modules",
    coreSourceModule: "lightwell_core::php_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerPhpHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/php-sample" },
};
