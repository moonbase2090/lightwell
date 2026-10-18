import type * as Monaco from "monaco-editor-core";

export function registerGoHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "go")) {
    return;
  }
  monaco.languages.register({ id: "go" });
  monaco.languages.setMonarchTokensProvider("go", {
    keywords: [
      "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
      "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
      "return", "select", "struct", "switch", "type", "var",
    ],
    typeKeywords: ["bool", "byte", "complex64", "complex128", "error", "float32", "float64", "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr"],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/"/, { token: "string", next: "@string" }],
        [/`/, { token: "string", next: "@raw" }],
      ],
      comment: [
        [/[^*/]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/./, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string", next: "@pop" }],
      ],
      raw: [
        [/[^`]+/, "string"],
        [/`/, { token: "string", next: "@pop" }],
      ],
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
  });
}
