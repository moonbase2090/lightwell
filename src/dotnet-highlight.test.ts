import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOTNET_LANGUAGE_PACK } from "./languages/packs/dotnet.js";
import { monacoLanguageIdForPath } from "./languages/registry.js";

test("C# and VB.NET sources use their highlighters", () => {
  assert.equal(monacoLanguageIdForPath("csharp/Widget.cs"), "csharp");
  assert.equal(monacoLanguageIdForPath("csharp/Extra.CS"), "csharp");
  assert.equal(monacoLanguageIdForPath("vb/Part.vb"), "vb");
  assert.equal(monacoLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(DOTNET_LANGUAGE_PACK.extractor?.kind, "dotnet-module");
  assert.equal(typeof DOTNET_LANGUAGE_PACK.registerHighlighter, "function");
  const source = readFileSync(new URL("./languages/highlighters/csharp.ts", import.meta.url), "utf8");
  assert.match(source, /id: "csharp"/);
  assert.match(source, /id: "vb"/);
  assert.match(source, /ignoreCase: true/);
  assert.match(source, /"namespace"/);
  assert.match(source, /"class"/);
  assert.match(source, /"record"/);
  assert.match(source, /"Imports"/);
  assert.match(source, /"Namespace"/);
  assert.match(source, /"Structure"/);
});
