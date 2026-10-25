import type * as Monaco from "monaco-editor-core";

export function registerRubyHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "ruby")) {
    return;
  }
  monaco.languages.register({ id: "ruby" });
  monaco.languages.setMonarchTokensProvider("ruby", {
    keywords: [
      "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else", "elsif",
      "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not", "or", "redo",
      "require", "require_relative", "rescue", "retry", "return", "self", "super", "then", "true",
      "undef", "unless", "until", "when", "while", "yield",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*[?!]?/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/#.*$/, "comment"],
        [/"/, { token: "string", next: "@string" }],
        [/'/, { token: "string", next: "@sstring" }],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string", next: "@pop" }],
      ],
      sstring: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string", next: "@pop" }],
      ],
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
  });
}
