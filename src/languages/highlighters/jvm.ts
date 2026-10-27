import type * as Monaco from "monaco-editor-core";

export function registerJvmHighlighters(monaco: typeof Monaco): void {
  registerJava(monaco);
  registerKotlin(monaco);
}

function registerJava(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "java")) return;
  monaco.languages.register({ id: "java" });
  monaco.languages.setMonarchTokensProvider("java", {
    keywords: [
      "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
      "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
      "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new",
      "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super",
      "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile",
      "while", "var", "yield", "record", "sealed", "permits", "true", "false", "null",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/"""/, { token: "string", next: "@text" }],
        [/"/, { token: "string", next: "@string" }],
        [/'([^'\\]|\\.)'/, "string"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/*]/, "comment"],
      ],
      text: [
        [/[^"]+/, "string"],
        [/"""/, { token: "string", next: "@pop" }],
        [/"/, "string"],
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

function registerKotlin(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "kotlin")) return;
  monaco.languages.register({ id: "kotlin" });
  monaco.languages.setMonarchTokensProvider("kotlin", {
    keywords: [
      "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in",
      "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true",
      "try", "typealias", "val", "var", "when", "while", "by", "catch", "constructor", "delegate",
      "dynamic", "field", "file", "finally", "get", "import", "init", "param", "property",
      "receiver", "set", "setparam", "where", "actual", "abstract", "annotation", "companion",
      "const", "crossinline", "data", "enum", "expect", "external", "final", "infix", "inline",
      "inner", "internal", "lateinit", "noinline", "open", "operator", "out", "override", "private",
      "protected", "public", "reified", "sealed", "suspend", "tailrec", "value", "vararg",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/"""/, { token: "string", next: "@raw" }],
        [/"/, { token: "string", next: "@string" }],
        [/'([^'\\]|\\.)'/, "string"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/*]/, "comment"],
      ],
      raw: [
        [/[^"]+/, "string"],
        [/"""/, { token: "string", next: "@pop" }],
        [/"/, "string"],
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
