import assert from "node:assert/strict";
import test from "node:test";
import {
  LANGUAGE_REGISTRY,
  monacoLanguageIdForPath,
  sourceLanguageIdForPath,
} from "./languages/registry.js";

test("registry maps Rust and manifest paths", () => {
  assert.equal(sourceLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(monacoLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(sourceLanguageIdForPath("Cargo.toml"), "toml");
  assert.equal(monacoLanguageIdForPath("crates/app/Cargo.toml"), "toml");
});

test("registry maps TypeScript extensions without .ts swallowing .tsx", () => {
  assert.equal(sourceLanguageIdForPath("src/App.tsx"), "typescript");
  assert.equal(sourceLanguageIdForPath("src/cli.ts"), "typescript");
  assert.equal(sourceLanguageIdForPath("tool.mts"), "typescript");
  assert.equal(sourceLanguageIdForPath("config.cts"), "typescript");
  assert.equal(monacoLanguageIdForPath("src/App.tsx"), "typescript");
});

test("unknown paths keep Rust highlighting for Monaco", () => {
  assert.equal(sourceLanguageIdForPath("README.md"), null);
  assert.equal(monacoLanguageIdForPath("README.md"), "rust");
});

test("registry entries have unique longest extensions", () => {
  const extensions = LANGUAGE_REGISTRY.flatMap((entry) => entry.extensions);
  assert.equal(new Set(extensions).size, extensions.length);
});
