import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TYPESCRIPT_LANGUAGE_PACK } from "./languages/packs/typescript.js";
import { monacoLanguageIdForPath } from "./languages/registry.js";

test("typescript sources use the typescript highlighter", () => {
  assert.equal(monacoLanguageIdForPath("src/cli.ts"), "typescript");
  assert.equal(monacoLanguageIdForPath("src/App.tsx"), "typescript");
  assert.equal(typeof TYPESCRIPT_LANGUAGE_PACK.registerHighlighter, "function");
  const source = readFileSync(new URL("./languages/highlighters/typescript.ts", import.meta.url), "utf8");
  assert.match(source, /languages\.register\(\{ id: "typescript" \}\)/);
});
