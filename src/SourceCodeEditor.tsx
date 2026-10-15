import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor-core";
import EditorWorker from "./editor.worker.js?worker";
import { monacoLanguageIdForPath, registerLanguagePackHighlighters } from "./languages/registry.js";
import type { ResolvedTheme } from "./theme.js";
import { parseShortcut } from "./source-view-preferences.js";

interface MonacoWorkerWindow extends Window {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
}

let themeConfigured = false;

export function configureMonaco() {
  const workerWindow = window as MonacoWorkerWindow;
  workerWindow.MonacoEnvironment ??= {
    getWorker: () => new EditorWorker(),
  };

  registerLanguagePackHighlighters(monaco);

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
    monaco.editor.defineTheme("lightwell-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "2A5A8A" },
        { token: "type", foreground: "3A6A4A" },
        { token: "type.identifier", foreground: "2A5A8A" },
        { token: "annotation", foreground: "6A6A2A" },
        { token: "string", foreground: "3A6A4A" },
        { token: "comment", foreground: "8B8278", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#f5f3f0",
        "editor.foreground": "#3A3530",
        "editorLineNumber.foreground": "#AAA399",
        "editorLineNumber.activeForeground": "#6B6560",
        "editor.lineHighlightBackground": "#ebe7e2",
        "editor.selectionBackground": "#6b85a844",
        "editorCursor.foreground": "#526a89",
        "editorGutter.background": "#f5f3f0",
      },
    });
    monaco.editor.defineTheme("lightwell-blueprint", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "", foreground: "EAF2FF" },
        { token: "keyword", foreground: "FFC46B" },
        { token: "type", foreground: "7FE3CF" },
        { token: "type.identifier", foreground: "9FD0FF" },
        { token: "annotation", foreground: "E2B8FA" },
        { token: "string", foreground: "B9E58C" },
        { token: "number", foreground: "FFB3BE" },
        { token: "comment", foreground: "8FA6C6", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#0C1A30",
        "editor.foreground": "#EAF2FF",
        "editorLineNumber.foreground": "#7F9AC0",
        "editorLineNumber.activeForeground": "#FFD08A",
        "editor.lineHighlightBackground": "#13284A",
        "editor.selectionBackground": "#2C4C7C",
        "editorCursor.foreground": "#FFB547",
        "editorGutter.background": "#0C1A30",
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
  readonly theme: ResolvedTheme;
  readonly wordWrap: boolean;
  /** Keyboard shortcut that toggles word wrap, such as "Alt+Z"; "" for none. */
  readonly wordWrapShortcut: string;
  readonly onToggleWordWrap: () => void;
  /** When set, replaces the browser menu with the app's menu for the clicked or focused line. */
  readonly onLineContextMenu?: (line: number, x: number, y: number) => void;
}

export const monacoThemes = {
  dark: "lightwell-dark",
  light: "lightwell-light",
  blueprint: "lightwell-blueprint",
} satisfies Record<ResolvedTheme, string>;

/** Monaco keybinding for a shortcut. Ctrl is the Control key and Meta is Cmd or the Windows key on every platform. */
function monacoKeybinding(text: string): number | null {
  const shortcut = parseShortcut(text);
  if (shortcut === null) return null;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const keyName = /^[A-Z]$/.test(shortcut.key) ? `Key${shortcut.key}` : /^[0-9]$/.test(shortcut.key) ? `Digit${shortcut.key}` : shortcut.key;
  const keyCode = (monaco.KeyCode as unknown as Record<string, number | undefined>)[keyName];
  if (keyCode === undefined) return null;
  let binding = keyCode;
  if (shortcut.ctrl) binding |= mac ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
  if (shortcut.meta) binding |= mac ? monaco.KeyMod.CtrlCmd : monaco.KeyMod.WinCtrl;
  if (shortcut.alt) binding |= monaco.KeyMod.Alt;
  if (shortcut.shift) binding |= monaco.KeyMod.Shift;
  return binding;
}

export default function SourceCodeEditor({ content, line, column, path, theme, wordWrap, wordWrapShortcut, onToggleWordWrap, onLineContextMenu }: SourceCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const contextMenuRef = useRef(onLineContextMenu);
  contextMenuRef.current = onLineContextMenu;
  const hasContextMenu = onLineContextMenu !== undefined;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const wordWrapRef = useRef(wordWrap);
  wordWrapRef.current = wordWrap;
  const toggleWrapRef = useRef(onToggleWordWrap);
  toggleWrapRef.current = onToggleWordWrap;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    configureMonaco();
    const language = monacoLanguageIdForPath(path);
    const editor = monaco.editor.create(container, {
      value: content,
      language,
      theme: monacoThemes[themeRef.current],
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
      contextmenu: !hasContextMenu,
      wordWrap: wordWrapRef.current ? "on" : "off",
    });
    editorRef.current = editor;
    const wrapBinding = monacoKeybinding(wordWrapShortcut);
    if (wrapBinding !== null) editor.addCommand(wrapBinding, () => toggleWrapRef.current());
    // Monaco measures glyph widths at creation. If the monospace font loads
    // later, text is drawn under the line-number gutter and the first
    // characters of each line are hidden until the widths are measured again.
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) monaco.editor.remeasureFonts();
    });
    const suppressBrowserMenu = (event: MouseEvent) => event.preventDefault();
    if (hasContextMenu) {
      container.addEventListener("contextmenu", suppressBrowserMenu);
      editor.onContextMenu((event) => {
        const lineNumber = event.target.position?.lineNumber ?? editor.getPosition()?.lineNumber ?? 1;
        contextMenuRef.current?.(lineNumber, event.event.posx, event.event.posy);
      });
      const openFromKeyboard = () => {
        const position = editor.getPosition() ?? { lineNumber: 1, column: 1 };
        const visible = editor.getScrolledVisiblePosition(position);
        const rect = container.getBoundingClientRect();
        contextMenuRef.current?.(position.lineNumber, rect.left + (visible?.left ?? 0), rect.top + (visible?.top ?? 0) + (visible?.height ?? 20));
      };
      editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F10, openFromKeyboard);
      editor.addCommand(monaco.KeyCode.ContextMenu, openFromKeyboard);
    }
    const targetLine = Math.min(Math.max(1, line), editor.getModel()?.getLineCount() ?? 1);
    const targetColumn = Math.max(1, column);
    editor.setPosition({ lineNumber: targetLine, column: targetColumn });
    editor.revealPositionInCenter({ lineNumber: targetLine, column: targetColumn });
    return () => {
      disposed = true;
      editorRef.current = null;
      container.removeEventListener("contextmenu", suppressBrowserMenu);
      editor.dispose();
    };
  }, [column, content, hasContextMenu, line, path, wordWrapShortcut]);

  useEffect(() => {
    configureMonaco();
    monaco.editor.setTheme(monacoThemes[theme]);
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);

  return <div className="source-code-editor" ref={containerRef} />;
}
