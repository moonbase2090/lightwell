import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PYTHON_LANGUAGE_PACK } from "./languages/packs/python.js";
import { monacoLanguageIdForPath } from "./languages/registry.js";

test("python sources use the python highlighter", () => {
  assert.equal(monacoLanguageIdForPath("sample_pkg/api.py"), "python");
  assert.equal(monacoLanguageIdForPath("sample_pkg/types.pyi"), "python");
  assert.equal(monacoLanguageIdForPath("Cargo.toml"), "toml");
  assert.equal(monacoLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(PYTHON_LANGUAGE_PACK.extractor?.kind, "python-module");
  assert.equal(typeof PYTHON_LANGUAGE_PACK.registerHighlighter, "function");
  const source = readFileSync(new URL("./languages/highlighters/python.ts", import.meta.url), "utf8");
  assert.match(source, /languages\.register\(\{ id: "python" \}\)/);
  assert.match(source, /"def"/);
  assert.match(source, /"class"/);
  assert.match(source, /"import"/);
});
