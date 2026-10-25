import type * as Monaco from "monaco-editor-core";

export function registerPhpHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "php")) {
    return;
  }
  monaco.languages.register({ id: "php" });
  monaco.languages.setMonarchTokensProvider("php", {
    keywords: [
      "abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone",
      "const", "continue", "declare", "default", "do", "echo", "else", "elseif", "empty", "enddeclare",
      "endfor", "endforeach", "endif", "endswitch", "endwhile", "enum", "extends", "final", "finally",
      "fn", "for", "foreach", "function", "global", "goto", "if", "implements", "include", "include_once",
      "instanceof", "insteadof", "interface", "isset", "list", "match", "namespace", "new", "or",
      "print", "private", "protected", "public", "readonly", "require", "require_once", "return",
      "static", "switch", "throw", "trait", "try", "unset", "use", "var", "while", "xor", "yield",
    ],
    tokenizer: {
      root: [
        [/<\?(?:php|=)?/, "metatag"],
        [/\?>/, "metatag"],
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/#.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/"/, { token: "string", next: "@string" }],
        [/'/, { token: "string", next: "@sstring" }],
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
      sstring: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string", next: "@pop" }],
      ],
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
  });
}
