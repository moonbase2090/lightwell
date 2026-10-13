import type * as Monaco from "monaco-editor-core";

export function registerTomlHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "toml")) {
    return;
  }
  monaco.languages.register({ id: "toml" });
  monaco.languages.setMonarchTokensProvider("toml", {
    tokenizer: {
      root: [
        [/^\s*\[[^\]]+\]/, "keyword"],
        [/^\s*[A-Za-z0-9_-]+/, "variable"],
        [/\s*=/, "operator"],
        [/#.*$/, "comment"],
        [/(?:"(?:[^"\\]|\\.)*"|'[^']*')/, "string"],
        [/\b(?:true|false)\b/, "keyword"],
        [/-?\d+(?:\.\d+)?/, "number"],
      ],
    },
  });
}
