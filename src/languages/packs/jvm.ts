import type { LanguagePack } from "../language-pack.js";
import { registerJvmHighlighters } from "../highlighters/jvm.js";

/** Java and Kotlin facts are appended by the workspace extractor (`extractCargoMap`). */
export const JVM_LANGUAGE_PACK: LanguagePack = {
  id: "jvm",
  extensions: [".java", ".kt", ".kts"],
  monacoLanguageId: "java",
  monacoIdByExtension: {
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
  },
  extractor: {
    kind: "jvm-module",
    moduleId: "extract/jvm-modules",
    coreSourceModule: "lightwell_core::jvm_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerJvmHighlighters,
  fixtures: { root: "crates/lightwell-core/fixtures/jvm-sample" },
};
