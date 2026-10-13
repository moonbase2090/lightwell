import type * as Monaco from "monaco-editor-core";

export function registerTypeScriptHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "typescript")) {
    return;
  }
  monaco.languages.register({ id: "typescript" });
  monaco.languages.setMonarchTokensProvider("typescript", {
    keywords: [
      "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
      "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if",
      "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw",
      "true", "try", "typeof", "var", "void", "while", "with", "as", "implements", "interface",
      "let", "package", "private", "protected", "public", "static", "yield", "async", "await",
      "declare", "readonly", "type", "from", "of",
    ],
    typeKeywords: ["string", "number", "boolean", "object", "any", "unknown", "never", "symbol", "bigint"],
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
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/'/, { token: "string.quote", bracket: "@open", next: "@stringsingle" }],
        [/`/, { token: "string.quote", bracket: "@open", next: "@stringtemplate" }],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      stringsingle: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      stringtemplate: [
        [/[^\\`]+/, "string"],
        [/\\./, "string.escape"],
        [/`/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
      whitespace: [
        [/\s+/, "white"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[\/*]/, "comment"],
      ],
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
    operators: ["=", ">", "<", "!", "~", "?", ":", "==", "<=", ">=", "!=", "&&", "||", "++", "--", "+", "-", "*", "/", "&", "|", "^", "%", "<<", ">>", ">>>", "+=", "-=", "*=", "/=", "&=", "|=", "^=", "%=", "<<=", ">>=", ">>>="],
  });
}
