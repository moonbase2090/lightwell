import type { LanguagePack } from "../language-pack.js";
import { registerPythonHighlighter } from "../highlighters/python.js";

/** Python facts are appended by the Rust workspace extractor (`extractCargoMap`). */
export const PYTHON_LANGUAGE_PACK: LanguagePack = {
  id: "python",
  packVersion: "1.0.0",
  extensions: [".py", ".pyi"],
  monacoLanguageId: "python",
  basenameFiles: ["pyproject.toml", "setup.cfg", "setup.py"],
  extractor: {
    kind: "python-module",
    moduleId: "extract/python-modules",
    coreSourceModule: "lightwell_core::python_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerPythonHighlighter,
  fixtures: { root: "crates/lightwell-core/fixtures/python-sample" },
};
