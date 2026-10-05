import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor-core";
import EditorWorker from "./editor.worker.js?worker";

interface MonacoWorkerWindow extends Window {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
}

let themeConfigured = false;

function configureMonaco() {
  const workerWindow = window as MonacoWorkerWindow;
  workerWindow.MonacoEnvironment ??= {
    getWorker: () => new EditorWorker(),
  };

  if (!monaco.languages.getLanguages().some((language) => language.id === "rust")) {
    monaco.languages.register({ id: "rust" });
    monaco.languages.setMonarchTokensProvider("rust", {
      keywords: [
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
        "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
        "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
        "trait", "true", "type", "unsafe", "use", "where", "while",
      ],
      typeKeywords: ["bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize", "str", "u8", "u16", "u32", "u64", "u128", "usize"],
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

  if (!monaco.languages.getLanguages().some((language) => language.id === "toml")) {
    monaco.languages.register({ id: "toml" });
    monaco.languages.setMonarchTokensProvider("toml", {
      tokenizer: {
        root: [
          [/^\s*\[[^\]]+\]/, "keyword"],
          [/^\s*[A-Za-z0-9_-]+/, "variable"],
          [/\s*=/, "operator"],
          [/#.*$/, "comment"],
          [/(?:"(?:[^"\\]|\\.)*"|'[^']*')/, "string"],
          [/\b(?:true|false)\b/, "keyword"],
          [/-?\d+(?:\.\d+)?/, "number"],
        ],
      },
    });
  }

  if (!themeConfigured) {
    monaco.editor.defineTheme("lightwell-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "9CB5FF" },
        { token: "type", foreground: "72D6C0" },
        { token: "type.identifier", foreground: "83C9EC" },
        { token: "annotation", foreground: "D6A7F2" },
        { token: "string", foreground: "E5BD83" },
        { token: "comment", foreground: "78899C", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#101820",
        "editor.foreground": "#DCE5F0",
        "editorLineNumber.foreground": "#637386",
        "editorLineNumber.activeForeground": "#A9BAD0",
        "editor.lineHighlightBackground": "#192633",
        "editor.selectionBackground": "#33517A66",
        "editorCursor.foreground": "#93AEFF",
        "editorGutter.background": "#101820",
      },
    });
    themeConfigured = true;
  }
}

export interface SourceCodeEditorProps {
  readonly content: string;
  readonly line: number;
  readonly column: number;
  readonly path: string;
}

export default function SourceCodeEditor({ content, line, column, path }: SourceCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    configureMonaco();
    const language = path.endsWith(".toml") ? "toml" : "rust";
    const editor = monaco.editor.create(container, {
      value: content,
      language,
      theme: "lightwell-dark",
      readOnly: true,
      domReadOnly: true,
      ariaLabel: `Read-only source: ${path}`,
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      glyphMargin: false,
      folding: false,
      fontSize: 11,
      lineHeight: 20,
      tabSize: 4,
      padding: { top: 13, bottom: 14 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });
    const targetLine = Math.min(Math.max(1, line), editor.getModel()?.getLineCount() ?? 1);
    const targetColumn = Math.max(1, column);
    editor.setPosition({ lineNumber: targetLine, column: targetColumn });
    editor.revealPositionInCenter({ lineNumber: targetLine, column: targetColumn });
    return () => editor.dispose();
  }, [column, content, line, path]);

  return <div className="source-code-editor" ref={containerRef} />;
}
