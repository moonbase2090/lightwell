import type * as Monaco from "monaco-editor-core";

export function registerCppHighlighter(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "cpp")) {
    return;
  }
  monaco.languages.register({ id: "cpp" });
  monaco.languages.setMonarchTokensProvider("cpp", {
    keywords: [
      "alignas", "alignof", "and", "and_eq", "asm", "auto", "bitand", "bitor", "bool", "break",
      "case", "catch", "char", "char8_t", "char16_t", "char32_t", "class", "compl", "concept",
      "const", "consteval", "constexpr", "constinit", "const_cast", "continue", "co_await",
      "co_return", "co_yield", "decltype", "default", "delete", "do", "double", "dynamic_cast",
      "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "goto",
      "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "not", "not_eq",
      "nullptr", "operator", "or", "or_eq", "private", "protected", "public", "register",
      "reinterpret_cast", "requires", "return", "short", "signed", "sizeof", "static",
      "static_assert", "static_cast", "struct", "switch", "template", "this", "thread_local",
      "throw", "true", "try", "typedef", "typeid", "typename", "union", "unsigned", "using",
      "virtual", "void", "volatile", "wchar_t", "while", "xor", "xor_eq",
    ],
    typeKeywords: [
      "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
      "size_t", "ssize_t", "ptrdiff_t", "intptr_t", "uintptr_t",
    ],
    tokenizer: {
      root: [
        [/#\s*[a-zA-Z_]\w*/, "keyword"],
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/"/, { token: "string", next: "@string" }],
        [/'/, { token: "string", next: "@char" }],
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
      char: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string", next: "@pop" }],
      ],
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
  });
}
