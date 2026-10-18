import type * as Monaco from "monaco-editor-core";

export function registerDotnetHighlighters(monaco: typeof Monaco): void {
  registerCsharp(monaco);
  registerVb(monaco);
}

function registerCsharp(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "csharp")) return;
  monaco.languages.register({ id: "csharp" });
  monaco.languages.setMonarchTokensProvider("csharp", {
    keywords: [
      "abstract", "as", "async", "await", "base", "bool", "break", "byte", "case", "catch", "char",
      "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else", "enum",
      "event", "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "global",
      "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace",
      "new", "null", "object", "operator", "out", "override", "params", "partial", "private", "protected",
      "public", "readonly", "record", "ref", "return", "sealed", "short", "sizeof", "stackalloc", "static",
      "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked",
      "unsafe", "ushort", "using", "var", "virtual", "void", "volatile", "while",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"""/, { token: "string", next: "@raw" }],
        [/@"/, { token: "string", next: "@verbatim" }],
        [/"/, { token: "string", next: "@string" }],
        [/'([^'\\]|\\.)'/, "string"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      raw: [
        [/[^"]+/, "string"],
        [/"""/, { token: "string", next: "@pop" }],
        [/"/, "string"],
      ],
      verbatim: [
        [/[^"]+/, "string"],
        [/""/, "string"],
        [/"/, { token: "string", next: "@pop" }],
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

function registerVb(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === "vb")) return;
  monaco.languages.register({ id: "vb" });
  monaco.languages.setMonarchTokensProvider("vb", {
    ignoreCase: true,
    keywords: [
      "AddHandler", "AddressOf", "Alias", "And", "AndAlso", "As", "Boolean", "ByRef", "ByVal", "Call",
      "Case", "Catch", "Class", "Const", "Continue", "Date", "Decimal", "Declare", "Default", "Delegate",
      "Dim", "Do", "Double", "Each", "Else", "ElseIf", "End", "Enum", "Erase", "Error", "Event", "Exit",
      "False", "Finally", "For", "Friend", "Function", "Get", "GetType", "Global", "GoTo", "Handles", "If",
      "Implements", "Imports", "In", "Inherits", "Integer", "Interface", "Is", "Let", "Lib", "Like", "Long",
      "Loop", "Me", "Mod", "Module", "MustInherit", "MustOverride", "MyBase", "MyClass", "Namespace", "New",
      "Next", "Not", "Nothing", "NotInheritable", "NotOverridable", "Object", "Of", "On", "Operator",
      "Option", "Optional", "Or", "OrElse", "Overloads", "Overridable", "Overrides", "ParamArray", "Partial",
      "Private", "Property", "Protected", "Public", "RaiseEvent", "ReadOnly", "ReDim", "RemoveHandler",
      "Resume", "Return", "Select", "Set", "Shadows", "Shared", "Short", "Single", "Static", "Step", "Stop",
      "String", "Structure", "Sub", "SyncLock", "Then", "Throw", "To", "True", "Try", "TryCast", "TypeOf",
      "Until", "Using", "When", "While", "Widening", "With", "WithEvents", "WriteOnly", "Xor",
    ],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, "operator"],
        [/\d[\d_]*(?:\.\d[\d_]*)?/, "number"],
        [/'.*$/, "comment"],
        [/"/, { token: "string", next: "@string" }],
      ],
      string: [
        [/[^"]+/, "string"],
        [/""/, "string.escape"],
        [/"/, { token: "string", next: "@pop" }],
      ],
    },
    symbols: /[=><!~?:&|+\-*/^%]+/,
  });
}
