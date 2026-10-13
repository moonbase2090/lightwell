import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WEB_LANGUAGE_PACK } from "./languages/packs/web.js";
import { monacoLanguageIdForPath } from "./languages/registry.js";

test("web pack maps Monaco ids per extension", () => {
  assert.equal(monacoLanguageIdForPath("src/cli.ts"), "typescript");
  assert.equal(monacoLanguageIdForPath("src/App.tsx"), "typescript");
  assert.equal(monacoLanguageIdForPath("src/App.jsx"), "javascript");
  assert.equal(monacoLanguageIdForPath("index.html"), "html");
  assert.equal(monacoLanguageIdForPath("styles/app.css"), "css");
  assert.equal(monacoLanguageIdForPath("styles/theme.scss"), "scss");
  assert.equal(monacoLanguageIdForPath("package.json"), "json");
  assert.equal(monacoLanguageIdForPath("vite.config.ts"), "typescript");
  assert.equal(typeof WEB_LANGUAGE_PACK.registerHighlighter, "function");
  const source = readFileSync(new URL("./languages/highlighters/typescript.ts", import.meta.url), "utf8");
  assert.match(source, /languages\.register\(\{ id: "typescript" \}\)/);
});
