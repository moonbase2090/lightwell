import type { LanguagePack } from "../language-pack.js";
import { registerDotnetHighlighters } from "../highlighters/csharp.js";

/** C# and VB.NET facts are appended by the workspace extractor (`extractCargoMap`). */
export const DOTNET_LANGUAGE_PACK: LanguagePack = {
  id: "dotnet",
  packVersion: "1.0.0",
  extensions: [".cs", ".vb"],
  monacoLanguageId: "csharp",
  monacoIdByExtension: {
    ".cs": "csharp",
    ".vb": "vb",
  },
  extractor: {
    kind: "dotnet-module",
    moduleId: "extract/dotnet-modules",
    coreSourceModule: "lightwell_core::dotnet_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerDotnetHighlighters,
  fixtures: { root: "crates/lightwell-core/fixtures/dotnet-sample" },
};
