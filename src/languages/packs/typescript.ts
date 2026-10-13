import type { LanguagePack } from "../language-pack.js";
import { registerTypeScriptHighlighter } from "../highlighters/typescript.js";

/** TypeScript modules are appended by workspace extraction (`extractCargoMap` / `typescript_source`). */
export const TYPESCRIPT_LANGUAGE_PACK: LanguagePack = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  monacoLanguageId: "typescript",
  extractor: {
    kind: "typescript-module",
    moduleId: "extract/typescript-modules",
    coreSourceModule: "lightwell_core::typescript_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerTypeScriptHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/typescript-sample" },
};
