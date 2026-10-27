import type * as Monaco from "monaco-editor-core";

export function registerSwiftHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "swift")) {
    return;
  }
  monaco.languages.register({ id: "swift" });
  monaco.languages.setMonarchTokensProvider("swift", {
    keywords: [
      "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import",
      "init", "inout", "internal", "let", "open", "operator", "private", "precedencegroup",
      "protocol", "public", "rethrows", "static", "struct", "subscript", "typealias", "var",
      "break", "case", "catch", "continue", "default", "defer", "do", "else", "fallthrough",
      "for", "guard", "if", "in", "repeat", "return", "throw", "switch", "where", "while",
      "as", "any", "false", "is", "nil", "self", "Self", "super", "throws", "true", "try",
      "async", "await", "actor", "nonisolated", "isolated", "consuming", "borrowing", "some",
      "package", "macro",
    ],
    typeKeywords: [
      "Bool", "String", "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16",
      "UInt32", "UInt64", "Float", "Double", "Character", "Any", "AnyObject", "Void", "Never",
      "Optional", "Array", "Dictionary", "Set", "Result", "Error",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/"/, { token: "string", next: "@string" }],
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
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
  });
}
