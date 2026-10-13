import type { LanguagePack } from "../language-pack.js";

export const PYTHON_LANGUAGE_PACK: LanguagePack = {
  id: "python",
  extensions: [".py", ".pyi"],
  monacoLanguageId: "python",
  extractor: null,
  workspaceExtractor: null,
  registerHighlighter: null,
  fixtures: null,
};
