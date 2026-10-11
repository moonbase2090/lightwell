import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EditorSettingsPanel from "./EditorSettingsPanel.js";
import type { MapEditorSource } from "./map-source.js";
import type { ResolvedTheme, ThemePreference } from "./theme.js";

const editor: MapEditorSource = {
  inspectBlock: () => Promise.reject(new Error("unused")),
  openBlock: () => Promise.reject(new Error("unused")),
  loadSettings: () => Promise.reject(new Error("unused")),
  saveSettings: () => Promise.reject(new Error("unused")),
  listPresets: () => Promise.reject(new Error("unused")),
};

function renderSettings(themePreference: ThemePreference, theme: ResolvedTheme): string {
  return renderToStaticMarkup(createElement(EditorSettingsPanel, {
    editor,
    themePreference,
    theme,
    onThemeChange: () => undefined,
    onClose: () => undefined,
  }));
}

test("settings panel warns about blueprint contrast and locks editor fields while they load", () => {
  const html = renderSettings("blueprint", "blueprint");

  assert.match(html, /role="dialog"/);
  assert.match(html, /<h2 id="editor-settings-title">Settings<\/h2>/);
  assert.match(html, /<option value="blueprint" selected="">Blueprint<\/option>/);
  assert.match(html, /role="note"/);
  assert.match(html, /some secondary text is below WCAG AA contrast/);
  assert.match(html, /Loading editor settings…/);
  assert.match(html, /id="editor-preset"[^>]*disabled/);
  assert.match(html, /id="editor-command"[^>]*disabled/);
  assert.match(html, /class="settings-save-button"[^>]*disabled/);
  assert.equal(html.includes("id=\"lightwell-theme\" disabled"), false);
  assert.match(html, /aria-label="Close settings"/);
});

test("settings panel hides the blueprint warning for the dark theme", () => {
  const html = renderSettings("dark", "dark");

  assert.match(html, /<option value="dark" selected="">Dark<\/option>/);
  assert.equal(html.includes("role=\"note\""), false);
  assert.equal(html.includes("WCAG AA"), false);
  assert.match(html, /<option value="system">Follow system<\/option>/);
  assert.match(html, /<option value="light">Light<\/option>/);
});
