import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor-core";
import { monacoLanguageIdForPath } from "./languages/registry.js";
import { configureMonaco, monacoThemes } from "./SourceCodeEditor.js";
import type { ResolvedTheme } from "./theme.js";
import { clampTextSize, codeLineHeight } from "./type-scale.js";

export interface SourceDiffEditorProps {
  readonly original: string;
  readonly modified: string;
  readonly path: string;
  /** Line in `modified` to reveal. */
  readonly line: number;
  readonly theme: ResolvedTheme;
  /** Source text size in pixels. */
  readonly fontSize: number;
}

/** Read-only side-by-side diff of one file in a commit. */
export default function SourceDiffEditor({ original, modified, path, line, theme, fontSize }: SourceDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    configureMonaco();
    const language = monacoLanguageIdForPath(path);
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    const editor = monaco.editor.createDiffEditor(container, {
      theme: monacoThemes[themeRef.current],
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      automaticLayout: true,
      // The source panel is narrow; fall back to inline when side by side does not fit.
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 520,
      minimap: { enabled: false },
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      glyphMargin: false,
      folding: false,
      fontSize: clampTextSize(fontSize, "code"),
      lineHeight: codeLineHeight(fontSize),
      renderOverviewRuler: false,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    const reveal = () => {
      const target = Math.min(Math.max(1, line), modifiedModel.getLineCount());
      editor.getModifiedEditor().revealLineInCenter(target);
    };
    // The diff is computed asynchronously; reveal once it lands so the hidden
    // unchanged regions do not shift the target.
    const updated = editor.onDidUpdateDiff(reveal);
    reveal();
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) monaco.editor.remeasureFonts();
    });
    return () => {
      disposed = true;
      updated.dispose();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [fontSize, line, modified, original, path]);

  useEffect(() => {
    configureMonaco();
    monaco.editor.setTheme(monacoThemes[theme]);
  }, [theme]);

  return <div className="source-code-editor source-diff-editor" ref={containerRef} aria-label={`Changes to ${path}`} />;
}
