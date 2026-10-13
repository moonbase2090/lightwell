import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { BUILTIN_LANGUAGE_PACKS } from "./languages/builtin-packs.js";
import { extractWorkspaceMap } from "./languages/extract-workspace.js";
import {
  LANGUAGE_REGISTRY,
  languagePackById,
  languagePackForPath,
  monacoLanguageIdForPath,
  sourceLanguageIdForPath,
} from "./languages/registry.js";

test("registry maps Rust and manifest paths", () => {
  assert.equal(sourceLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(monacoLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(sourceLanguageIdForPath("Cargo.toml"), "toml");
  assert.equal(monacoLanguageIdForPath("crates/app/Cargo.toml"), "toml");
});

test("registry maps Python sources", () => {
  assert.equal(sourceLanguageIdForPath("pkg/mod.py"), "python");
  assert.equal(sourceLanguageIdForPath("types.pyi"), "python");
  assert.equal(monacoLanguageIdForPath("pkg/mod.py"), "python");
});

test("registry maps TypeScript extensions without .ts swallowing .tsx", () => {
  assert.equal(sourceLanguageIdForPath("src/App.tsx"), "typescript");
  assert.equal(sourceLanguageIdForPath("src/cli.ts"), "typescript");
  assert.equal(sourceLanguageIdForPath("tool.mts"), "typescript");
  assert.equal(sourceLanguageIdForPath("config.cts"), "typescript");
  assert.equal(monacoLanguageIdForPath("src/App.tsx"), "rust");
});

test("unknown paths keep Rust highlighting for Monaco", () => {
  assert.equal(sourceLanguageIdForPath("README.md"), null);
  assert.equal(monacoLanguageIdForPath("README.md"), "rust");
});

test("registry entries have unique longest extensions", () => {
  const extensions = LANGUAGE_REGISTRY.flatMap((entry) => entry.extensions);
  assert.equal(new Set(extensions).size, extensions.length);
});

test("built-in packs expose extractor and fixture seams", () => {
  assert.equal(BUILTIN_LANGUAGE_PACKS.length, 4);
  const rust = languagePackForPath("src/lib.rs");
  assert.equal(rust?.extractor?.kind, "rust-workspace");
  assert.equal(rust?.extractor?.moduleTreeModule, "extract/rust-modules");
  assert.equal(rust?.fixtures?.root, "crates/lightwell-core/fixtures");
  assert.equal(typeof rust?.workspaceExtractor, "function");
  const toml = languagePackForPath("Cargo.toml");
  assert.equal(toml?.workspaceExtractor, null);
  const typescript = languagePackForPath("src/App.tsx");
  assert.equal(typescript?.extractor?.kind, "typescript-module");
  const python = languagePackForPath("mod.py");
  assert.equal(python?.extractor?.kind, "python-module");
  assert.equal(python?.fixtures?.root, "crates/lightwell-core/fixtures/python-sample");
  assert.equal(typeof python?.registerHighlighter, "function");
});

test("extractWorkspaceMap uses rust pack workspace extractor on fixture workspace", () => {
  const fixtureRoot = path.join(
    process.cwd(),
    "crates/lightwell-core/fixtures/no-cargo-workspace",
  );
  const args = { repositoryPath: fixtureRoot, projectName: "Fixture" };
  const viaRouter = extractWorkspaceMap(args);
  assert.deepEqual(viaRouter.stats, {
    blocks: 18,
    connections: 18,
    crates: 2,
    apps: 3,
    modules: 9,
    cargoFeatures: 3,
  });
  assert.equal(viaRouter.project.name, "Fixture");
  assert.ok(
    viaRouter.blocks.some((block) => block.id === "app:fixture-app:fixture-app"),
    "expected fixture-app app block from rust workspace extraction",
  );
  const rustPack = languagePackById("rust");
  assert.equal(typeof rustPack?.workspaceExtractor, "function");
  assert.equal(languagePackById("typescript")?.workspaceExtractor, null);
});
