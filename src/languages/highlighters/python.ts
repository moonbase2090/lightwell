import type * as Monaco from "monaco-editor-core";

export function registerPythonHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "python")) {
    return;
  }
  monaco.languages.register({ id: "python" });
  monaco.languages.setMonarchTokensProvider("python", {
    keywords: [
      "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
      "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import",
      "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
      "True", "try", "while", "with", "yield",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/#.*$/, "comment"],
        [/"""/, { token: "string", next: "@tripleDouble" }],
        [/'''/, { token: "string", next: "@tripleSingle" }],
        [/"/, { token: "string", next: "@stringDouble" }],
        [/'/, { token: "string", next: "@stringSingle" }],
      ],
      tripleDouble: [
        [/[^"]+/, "string"],
        [/"""/, { token: "string", next: "@pop" }],
        [/"/, "string"],
      ],
      tripleSingle: [
        [/[^']+/, "string"],
        [/'''/, { token: "string", next: "@pop" }],
        [/'/, "string"],
      ],
      stringDouble: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string", next: "@pop" }],
      ],
      stringSingle: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string", next: "@pop" }],
      ],
    },
    symbols: /[=><!~?:&|+\-*/%^]+/,
  });
}
