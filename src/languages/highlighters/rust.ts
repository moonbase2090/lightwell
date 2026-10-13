import type * as Monaco from "monaco-editor-core";

export function registerRustHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "rust")) {
    return;
  }
  monaco.languages.register({ id: "rust" });
  monaco.languages.setMonarchTokensProvider("rust", {
    keywords: [
      "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
      "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
      "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
      "trait", "true", "type", "unsafe", "use", "where", "while",
    ],
    typeKeywords: [
      "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize", "str",
      "u8", "u16", "u32", "u64", "u128", "usize",
    ],
    tokenizer: {
      root: [
        [/[a-z_$][\w$]*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } }],
        [/[A-Z][\w$]*/, "type.identifier"],
        { include: "@whitespace" },
        [/[{}()[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        [/\d[\d_]*(\.\d[\d_]*)?([eE][+-]?[\d_]+)?/, "number"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/'([^'\\]|\\.)'/, "string"],
        [/#\!?\[/, "annotation"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      whitespace: [
        [/\s+/, "white"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
    symbols: /[=><!~?&|+\-*\/%^]+/,
    operators: ["=", ">", "<", "!", "~", "?", ":", "&", "|", "+", "-", "*", "/", "%", "^"],
  });
}
