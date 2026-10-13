import type { LanguagePack } from "../language-pack.js";

export const TYPESCRIPT_LANGUAGE_PACK: LanguagePack = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  monacoLanguageId: "typescript",
  extractor: { kind: "typescript-module", moduleId: "extract/typescript-modules" },
  workspaceExtractor: null,
  registerHighlighter: null,
  fixtures: null,
};
