import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_TEXT_SIZE,
  clampTextSize,
  codeLineHeight,
  edgeLabelFontSize,
  formatTextSize,
  parseTextSize,
  readTextSize,
  stepTextSize,
  writeTextSize,
  type TextSizeStorage,
} from "./type-scale.js";

test("text size clamps scales to a tenth and code size to a pixel", () => {
  assert.equal(clampTextSize(1.26, "ui"), 1.3);
  assert.equal(clampTextSize(2, "ui"), 1.6);
  assert.equal(clampTextSize(0, "ui"), 0.8);
  assert.equal(clampTextSize(Number.NaN, "ui"), 1);
  assert.equal(clampTextSize(13.4, "code"), 13);
  assert.equal(clampTextSize(30, "code"), 22);
  assert.equal(clampTextSize(10, "code"), 11);
  assert.equal(clampTextSize(1.54, "labels"), 1.5);
  assert.equal(clampTextSize(0.74, "labels"), 0.8);
});

test("text size steps stop at the bounds", () => {
  assert.equal(stepTextSize(1, "ui", 1), 1.1);
  assert.equal(stepTextSize(1.6, "ui", 1), 1.6);
  assert.equal(stepTextSize(0.8, "labels", -1), 0.8);
  assert.equal(stepTextSize(13, "code", -1), 12);
  assert.equal(stepTextSize(11, "code", -1), 11);
  assert.equal(stepTextSize(22, "code", 1), 22);
});

test("text size parsing fills and rejects bad stored values", () => {
  assert.deepEqual(parseTextSize(null), DEFAULT_TEXT_SIZE);
  assert.deepEqual(parseTextSize("not json"), { ui: 1, code: 13, labels: 1 });
  assert.deepEqual(parseTextSize('{"code":16}'), { ui: 1, code: 16, labels: 1 });
  assert.deepEqual(parseTextSize('{"ui":1.4,"code":18,"labels":0.9}'), { ui: 1.4, code: 18, labels: 0.9 });
  assert.deepEqual(parseTextSize('{"ui":"big","code":"16","labels":null}'), { ui: 1, code: 13, labels: 1 });
  assert.deepEqual(parseTextSize('{"ui":9,"code":1,"labels":9}'), { ui: 1.6, code: 11, labels: 1.6 });
});

test("text size storage returns the defaults when it throws", () => {
  const throwing: TextSizeStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const memory = new Map<string, string>();
  const storage: TextSizeStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value); },
  };

  assert.deepEqual(readTextSize(null), { ui: 1, code: 13, labels: 1 });
  assert.deepEqual(readTextSize(throwing), { ui: 1, code: 13, labels: 1 });
  writeTextSize(throwing, { ui: 1.2, code: 16, labels: 1.1 });
  writeTextSize(storage, { ui: 1.2, code: 16, labels: 1.1 });
  assert.deepEqual(readTextSize(storage), { ui: 1.2, code: 16, labels: 1.1 });
  assert.equal(memory.size, 1);
});

test("text size formatting and code or edge pixels are fixed numbers", () => {
  assert.equal(formatTextSize(1, "ui"), "100%");
  assert.equal(formatTextSize(1.2, "labels"), "120%");
  assert.equal(formatTextSize(13, "code"), "13 px");
  assert.equal(codeLineHeight(11), 20);
  assert.equal(codeLineHeight(13), 24);
  assert.equal(edgeLabelFontSize(1), 12);
  assert.equal(edgeLabelFontSize(1.5), 18);
});

test("stylesheet raises the small defaults and scales ui text separately from labels", () => {
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

  assert.match(css, /--lw-ui-scale: 1;/);
  assert.match(css, /--lw-label-scale: 1;/);
  assert.match(css, /\.overview-metrics \{[^}]*calc\(12px \* var\(--lw-ui-scale, 1\)\)/);
  assert.match(css, /\.editor-settings-button \{[^}]*calc\(12px \* var\(--lw-ui-scale, 1\)\)/);
  assert.match(css, /\.overview-description \{[^}]*calc\(12px \* var\(--lw-ui-scale, 1\)\)/);
  assert.match(css, /\.file-badge \{[^}]*calc\(11px \* var\(--lw-label-scale, 1\)\)/);
  assert.match(css, /\.node-kind \{[^}]*calc\(11px \* var\(--lw-label-scale, 1\)\)/);
  assert.match(css, /\.node-name \{[^}]*calc\(12px \* var\(--lw-label-scale, 1\)\)/);
  assert.equal(css.includes("font: 8px"), false);
  assert.equal(css.includes("font: 9px"), false);
  assert.equal(css.includes("font-size: 8px"), false);
  assert.equal(css.includes("font-size: 9px"), false);
});

test("the app applies the stored sizes to the shell, the map labels, and the source view", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("./viewer/layout.ts", import.meta.url), "utf8");
  const source = readFileSync(new URL("./SourceCodeEditor.tsx", import.meta.url), "utf8");

  assert.match(app, /readTextSize\(/);
  assert.match(app, /writeTextSize\(/);
  assert.match(app, /textSizeVars\(textSize\)/);
  assert.match(app, /labelScale: textSize\.labels/);
  assert.match(app, /codeSize=\{textSize\.code\}/);
  assert.match(layout, /edgeLabelFontSize\(/);
  assert.match(source, /updateOptions\(\{[\s\S]*fontSize: clampTextSize\(fontSize, "code"\)/);
});
