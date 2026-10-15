import assert from "node:assert/strict";
import test from "node:test";
import { formatShortcut, parseShortcut, shortcutFromKeyEvent } from "./source-view-preferences.js";

const press = (code: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => shortcutFromKeyEvent({
  code,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
  metaKey: modifiers.meta ?? false,
});

test("shortcuts parse case-insensitively and format in a fixed modifier order", () => {
  assert.deepEqual(parseShortcut("alt+z"), { ctrl: false, alt: true, shift: false, meta: false, key: "Z" });
  assert.equal(formatShortcut(parseShortcut("shift+ctrl+w")!), "Ctrl+Shift+W");
  assert.equal(formatShortcut(parseShortcut("F9")!), "F9");
});

test("shortcuts without a usable modifier or key are rejected", () => {
  assert.equal(parseShortcut("Z"), null);
  assert.equal(parseShortcut("Shift+Z"), null);
  assert.equal(parseShortcut("Alt+Space"), null);
  assert.equal(parseShortcut("Hyper+Z"), null);
  assert.equal(parseShortcut("Alt+Alt+Z"), null);
  assert.equal(parseShortcut("F13"), null);
  assert.equal(parseShortcut(""), null);
});

test("recording uses the physical key and ignores what the modifier types", () => {
  assert.equal(press("KeyZ", { alt: true }), "Alt+Z");
  assert.equal(press("KeyW", { ctrl: true, shift: true }), "Ctrl+Shift+W");
  assert.equal(press("Digit3", { meta: true }), "Meta+3");
  assert.equal(press("F2"), "F2");
  assert.equal(press("KeyZ"), null);
  assert.equal(press("KeyZ", { shift: true }), null);
  assert.equal(press("Space", { alt: true }), null);
});
