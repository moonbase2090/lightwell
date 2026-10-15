import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SourceInspectorPanel, { type SourceInspectionState } from "./SourceInspectorPanel.js";
import type { ResolvedTheme } from "./theme.js";

function renderInspector(inspection: SourceInspectionState, options: {
  readonly openingEditor?: boolean;
  readonly editorError?: string;
  readonly theme?: ResolvedTheme;
} = {}): string {
  return renderToStaticMarkup(createElement(SourceInspectorPanel, {
    title: "parser",
    inspection,
    theme: options.theme ?? "dark",
    wordWrap: false,
    wordWrapShortcut: "Alt+Z",
    onToggleWordWrap: () => undefined,
    openingEditor: options.openingEditor ?? false,
    editorError: options.editorError ?? "",
    onOpenInEditor: () => undefined,
    onClose: () => undefined,
  }));
}

function buttonOpen(html: string): string {
  const match = html.match(/<button class="open-in-editor-button"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(match !== null);
  return match[0];
}

test("source inspector stays closed to editing while a file is loading", () => {
  const html = renderInspector({ kind: "loading" });

  assert.match(html, /aria-label="Source inspector for parser"/);
  assert.match(html, /<h2>parser<\/h2>/);
  assert.match(html, /Loading source…/);
  assert.match(buttonOpen(html), /disabled/);
  assert.match(buttonOpen(html), /Open in editor/);
  assert.equal(html.includes("LINE "), false);
  assert.equal(html.includes("inspector-error"), false);
});

test("source inspector reports a read failure and keeps the editor closed", () => {
  const html = renderInspector({ kind: "error", message: "missing file" });

  assert.match(html, /role="alert"/);
  assert.match(html, /missing file/);
  assert.match(buttonOpen(html), /disabled/);
  assert.equal(html.includes("LINE "), false);
});

test("source inspector shows the file position and the editor failure", () => {
  const html = renderInspector({
    kind: "ready",
    document: { path: "crates/core/src/parser.rs", content: "fn parse() {}", line: 4, column: 2 },
  }, { editorError: "editor missing", theme: "light" });
  const button = buttonOpen(html);

  assert.match(html, /<code title="crates\/core\/src\/parser.rs">crates\/core\/src\/parser.rs<\/code>/);
  assert.match(html, /LINE 4 .* COLUMN 2/);
  assert.equal(button.includes("disabled"), false);
  assert.match(button, /Open in editor/);
  assert.match(html, /<div class="inspector-error" role="alert">[\s\S]*editor missing/);
});

test("source inspector disables opening while an editor launch is in progress", () => {
  const html = renderInspector({
    kind: "ready",
    document: { path: "src/parser.rs", content: "fn parse() {}", line: 1, column: 1 },
  }, { openingEditor: true });

  assert.match(buttonOpen(html), /disabled/);
  assert.match(buttonOpen(html), /Opening editor…/);
});
