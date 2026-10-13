import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EditorSettingsPanel, {
  SaveEditorButton,
  SaveStatusMessage,
  saveEditorPreference,
  type SaveStatus,
} from "./EditorSettingsPanel.js";
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

test("settings panel shows blueprint without a contrast disclaimer and locks editor fields while they load", () => {
  const html = renderSettings("blueprint", "blueprint");

  assert.match(html, /role="dialog"/);
  assert.match(html, /<h2 id="editor-settings-title">Settings<\/h2>/);
  assert.match(html, /<option value="blueprint" selected="">Blueprint<\/option>/);
  assert.equal(html.includes("role=\"note\""), false);
  assert.equal(html.includes("WCAG AA"), false);
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

function renderFooter(status: SaveStatus): string {
  return renderToStaticMarkup(createElement("footer", null,
    createElement(SaveStatusMessage, { status }),
    createElement(SaveEditorButton, { status, disabled: false, onSave: () => undefined }),
  ));
}

test("saving an editor preference returns the stored settings and a Saved status", async () => {
  const stored: Array<string | null> = [];
  const outcome = await saveEditorPreference({
    saveSettings: (settings) => {
      stored.push(settings.commandTemplate);
      return Promise.resolve({ commandTemplate: "code --goto {file}:{line}" });
    },
  }, "  code --goto {file}:{line}  ");

  assert.deepEqual(stored, ["code --goto {file}:{line}"]);
  assert.equal(outcome.status.kind, "saved");
  assert.ok("settings" in outcome);
  assert.equal(outcome.settings.commandTemplate, "code --goto {file}:{line}");
});

test("a blank template is saved as null so the OS default app is used", async () => {
  const stored: Array<string | null> = [];
  await saveEditorPreference({
    saveSettings: (settings) => { stored.push(settings.commandTemplate); return Promise.resolve(settings); },
  }, "   ");
  assert.deepEqual(stored, [null]);
});

test("a failed save reports the backend error message", async () => {
  const outcome = await saveEditorPreference({
    saveSettings: () => Promise.reject(new Error("settings file is read-only")),
  }, "zed {file}");
  assert.deepEqual(outcome.status, { kind: "error", message: "settings file is read-only" });
  assert.equal("settings" in outcome, false);
});

test("a failed save without a message falls back to a save-specific error", async () => {
  const outcome = await saveEditorPreference({ saveSettings: () => Promise.reject(undefined) }, "zed {file}");
  assert.deepEqual(outcome.status, { kind: "error", message: "Could not save editor preference." });
});

test("Saved status renders a polite live region with a check and no alert", () => {
  const html = renderFooter({ kind: "saved" });
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"><span class="settings-saved"><svg[^]*<\/svg>Saved<\/span>/);
  assert.equal(html.includes("role=\"alert\""), false);
  assert.match(html, /<button class="settings-save-button" type="button" aria-busy="false">/);
});

test("save errors render a visible alert and leave the live region empty", () => {
  const html = renderFooter({ kind: "error", message: "settings file is read-only" });
  assert.match(html, /class="settings-error settings-save-error" role="alert"><svg[^]*<\/svg>settings file is read-only<\/div>/);
  assert.match(html, /aria-live="polite" aria-atomic="true"><\/div>/);
  assert.equal(html.includes(">Saved<"), false);
});

test("while saving the button is disabled, busy, and shows a spinner", () => {
  const html = renderFooter({ kind: "saving" });
  assert.match(html, /<button class="settings-save-button" type="button" disabled="" aria-busy="true"><svg[^>]*settings-save-spinner[^]*<\/svg>Saving…<\/button>/);
  assert.equal(html.includes(">Saved<"), false);
});

test("idle state shows neither Saved nor an error", () => {
  const html = renderFooter({ kind: "idle" });
  assert.equal(html.includes(">Saved<"), false);
  assert.equal(html.includes("role=\"alert\""), false);
  assert.match(html, /aria-busy="false">[^]*Save editor preference<\/button>/);
});
