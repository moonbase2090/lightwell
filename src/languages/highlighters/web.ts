import type * as Monaco from "monaco-editor-core";
import { registerTypeScriptHighlighter } from "./typescript.js";

/** Registers custom Monarch for TypeScript; JS/TSX/HTML/CSS use Monaco built-ins where available. */
export function registerWebHighlighters(monaco: typeof Monaco): void {
  registerTypeScriptHighlighter(monaco);
  if (!monaco.languages.getLanguages().some((language) => language.id === "javascript")) {
    monaco.languages.register({ id: "javascript" });
  }
}
