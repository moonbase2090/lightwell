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
import type { UpdateDelivery } from "./app-updates.js";
import type { MapEditorSource } from "./map-source.js";
import type { ResolvedTheme, ThemePreference } from "./theme.js";

const editor: MapEditorSource = {
  inspectBlock: () => Promise.reject(new Error("unused")),
  openBlock: () => Promise.reject(new Error("unused")),
  loadSettings: () => Promise.reject(new Error("unused")),
  saveSettings: () => Promise.reject(new Error("unused")),
  listPresets: () => Promise.reject(new Error("unused")),
};

function renderSettings(
  themePreference: ThemePreference,
  theme: ResolvedTheme,
  extra: {
    readonly editor?: MapEditorSource;
    readonly updateDelivery?: UpdateDelivery;
    readonly autoUpdateCheck?: boolean;
    readonly updateStatus?: string;
  } = {},
): string {
  return renderToStaticMarkup(createElement(EditorSettingsPanel, {
    editor,
    themePreference,
    theme,
    onThemeChange: () => undefined,
    wordWrapShortcut: "Ctrl+Shift+W",
    onWordWrapShortcutChange: () => undefined,
    updateDelivery: "integrated",
    autoUpdateCheck: true,
    onAutoUpdateCheckChange: () => undefined,
    updateStatus: "",
    onCheckForUpdate: () => undefined,
    onClose: () => undefined,
    ...extra,
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

test("settings show the configured word wrap shortcut", () => {
  const html = renderSettings("system", "dark");
  assert.match(html, /WORD WRAP SHORTCUT/);
  assert.match(html, /<kbd>Ctrl\+Shift\+W<\/kbd>/);
});

test("desktop settings offer an automatic update check and install notes", () => {
  const html = renderSettings("dark", "dark", { updateStatus: "Version 0.1.13 is available." });
  assert.match(html, /id="lightwell-auto-update"[^>]*checked/);
  assert.match(html, /Automatically check for updates/);
  assert.match(html, /shows the release notes before it installs/);
  assert.match(html, /Check now/);
  assert.equal(html.includes("Check now\" disabled"), false);
  assert.match(html, /Version 0\.1\.13 is available\./);
});

test("a manual package links to the release instead of installing", () => {
  const html = renderSettings("dark", "dark", { updateDelivery: "manual", autoUpdateCheck: false });
  const checkbox = html.match(/<input id="lightwell-auto-update"[^>]*>/);
  assert.ok(checkbox !== null);
  assert.equal(checkbox[0].includes("checked"), false);
  assert.match(html, /cannot replace itself/);
  assert.match(html, /download link/);
});

test("the browser preview saves the update choice and does not check", () => {
  const html = renderSettings("light", "light", { editor: undefined, updateDelivery: "unavailable" });
  assert.match(html, /Update checks run in the desktop app/);
  assert.match(html, /<button class="settings-shortcut-action" type="button" disabled="">Check now<\/button>/);
  assert.equal(html.includes("EDITOR COMMAND TEMPLATE"), false);
  assert.equal(html.includes("Save editor preference"), false);
  assert.match(html, /id="lightwell-theme"/);
});
