import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("registry matches basenames in Windows paths", () => {
  assert.equal(sourceLanguageIdForPath(String.raw`C:\repo\web\package.json`), "web");
  assert.equal(monacoLanguageIdForPath(String.raw`C:\repo\web\package.json`), "json");
  assert.equal(monacoLanguageIdForPath(String.raw`C:\repo\web\vite.config.ts`), "typescript");
});

test("the viewer's language registry does not import Node built-ins", () => {
  // The source inspector bundles this module. Vite stubs node:* imports in the browser,
  // so path.basename throws and React unmounts the window when a module is opened.
  const source = readFileSync(path.join(import.meta.dirname, "languages", "registry.ts"), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/);
});

test("registry maps Python sources", () => {
  assert.equal(sourceLanguageIdForPath("pkg/mod.py"), "python");
  assert.equal(sourceLanguageIdForPath("types.pyi"), "python");
  assert.equal(monacoLanguageIdForPath("pkg/mod.py"), "python");
});

test("registry maps Go sources", () => {
  assert.equal(sourceLanguageIdForPath("pkg/main.go"), "go");
  assert.equal(monacoLanguageIdForPath("pkg/main.go"), "go");
});

test("registry maps PHP and Ruby sources", () => {
  assert.equal(sourceLanguageIdForPath("app/Models/User.php"), "php");
  assert.equal(monacoLanguageIdForPath("app/Models/User.php"), "php");
  assert.equal(sourceLanguageIdForPath("app/models/user.rb"), "ruby");
  assert.equal(monacoLanguageIdForPath("app/models/user.rb"), "ruby");
});

test("registry maps C/C++ sources", () => {
  assert.equal(sourceLanguageIdForPath("src/main.cpp"), "cpp");
  assert.equal(sourceLanguageIdForPath("src/greeter.h"), "cpp");
  assert.equal(sourceLanguageIdForPath("legacy.c"), "cpp");
  assert.equal(monacoLanguageIdForPath("src/main.cpp"), "cpp");
  assert.equal(monacoLanguageIdForPath("src/greeter.h"), "cpp");
  assert.equal(monacoLanguageIdForPath("legacy.c"), "cpp");
});

test("registry maps Java and Kotlin sources", () => {
  assert.equal(sourceLanguageIdForPath("src/App.java"), "jvm");
  assert.equal(monacoLanguageIdForPath("src/App.java"), "java");
  assert.equal(sourceLanguageIdForPath("src/Greeter.kt"), "jvm");
  assert.equal(monacoLanguageIdForPath("src/Greeter.kt"), "kotlin");
  assert.equal(sourceLanguageIdForPath("src/script.kts"), "jvm");
  assert.equal(monacoLanguageIdForPath("src/script.kts"), "kotlin");
});

test("registry maps YAML, Terraform and Dockerfile paths", () => {
  assert.equal(sourceLanguageIdForPath(".github/workflows/deploy.yml"), "config-infra");
  assert.equal(monacoLanguageIdForPath(".github/workflows/deploy.yml"), "yaml");
  assert.equal(sourceLanguageIdForPath("infra/main.tf"), "config-infra");
  assert.equal(monacoLanguageIdForPath("infra/main.tf"), "terraform");
  assert.equal(sourceLanguageIdForPath(String.raw`C:\repo\infra\Dockerfile.dev`), "config-infra");
  assert.equal(monacoLanguageIdForPath(String.raw`C:\repo\infra\Dockerfile.dev`), "dockerfile");
});

test("registry maps Swift sources", () => {
  assert.equal(sourceLanguageIdForPath("Sources/App/main.swift"), "swift");
  assert.equal(monacoLanguageIdForPath("Sources/App/main.swift"), "swift");
});

test("registry maps web extensions without .ts swallowing .tsx", () => {
  assert.equal(sourceLanguageIdForPath("src/App.tsx"), "web");
  assert.equal(sourceLanguageIdForPath("src/cli.ts"), "web");
  assert.equal(sourceLanguageIdForPath("legacy.js"), "web");
  assert.equal(sourceLanguageIdForPath("index.html"), "web");
  assert.equal(sourceLanguageIdForPath("package.json"), "web");
  assert.equal(monacoLanguageIdForPath("src/App.tsx"), "typescript");
  assert.equal(monacoLanguageIdForPath("legacy.jsx"), "javascript");
  assert.equal(monacoLanguageIdForPath("index.html"), "html");
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
  assert.equal(BUILTIN_LANGUAGE_PACKS.length, 11);
  const rust = languagePackForPath("src/lib.rs");
  assert.equal(rust?.extractor?.kind, "rust-workspace");
  assert.equal(rust?.extractor?.moduleTreeModule, "extract/rust-modules");
  assert.equal(rust?.fixtures?.root, "crates/lightwell-core/fixtures");
  assert.equal(typeof rust?.workspaceExtractor, "function");
  const toml = languagePackForPath("Cargo.toml");
  assert.equal(toml?.workspaceExtractor, null);
  const web = languagePackForPath("src/App.tsx");
  assert.equal(web?.extractor?.kind, "web-module");
  assert.equal(web?.fixtures?.root, "crates/lightwell-core/fixtures/web-sample");
  assert.equal(typeof web?.registerHighlighter, "function");
  const python = languagePackForPath("mod.py");
  assert.equal(python?.extractor?.kind, "python-module");
  assert.equal(python?.fixtures?.root, "crates/lightwell-core/fixtures/python-sample");
  assert.equal(typeof python?.registerHighlighter, "function");
  const go = languagePackForPath("main.go");
  assert.equal(go?.extractor?.kind, "go-module");
  assert.equal(go?.fixtures?.root, "crates/lightwell-core/fixtures/go-sample");
  assert.equal(typeof go?.registerHighlighter, "function");
  const dotnet = languagePackForPath("Widget.cs");
  assert.equal(dotnet?.id, "dotnet");
  assert.equal(dotnet?.extractor?.kind, "dotnet-module");
  assert.equal(dotnet?.fixtures?.root, "crates/lightwell-core/fixtures/dotnet-sample");
  assert.equal(monacoLanguageIdForPath("Widget.cs"), "csharp");
  assert.equal(monacoLanguageIdForPath("Part.vb"), "vb");
  assert.equal(typeof dotnet?.registerHighlighter, "function");
  const php = languagePackForPath("app/Models/User.php");
  assert.equal(php?.id, "php");
  assert.equal(php?.extractor?.kind, "php-module");
  assert.equal(php?.fixtures?.root, "crates/lightwell-core/fixtures/php-sample");
  assert.equal(typeof php?.registerHighlighter, "function");
  const ruby = languagePackForPath("app/models/user.rb");
  assert.equal(ruby?.id, "ruby");
  assert.equal(ruby?.extractor?.kind, "ruby-module");
  assert.equal(ruby?.fixtures?.root, "crates/lightwell-core/fixtures/ruby-sample");
  assert.equal(typeof ruby?.registerHighlighter, "function");
  const jvm = languagePackForPath("App.java");
  assert.equal(jvm?.id, "jvm");
  assert.equal(jvm?.extractor?.kind, "jvm-module");
  assert.equal(jvm?.fixtures?.root, "crates/lightwell-core/fixtures/jvm-sample");
  assert.equal(languagePackForPath("Greeter.kt")?.id, "jvm");
  assert.equal(languagePackForPath("script.kts")?.id, "jvm");
  assert.equal(typeof jvm?.registerHighlighter, "function");
  const swift = languagePackForPath("Sources/App/main.swift");
  assert.equal(swift?.id, "swift");
  assert.equal(swift?.extractor?.kind, "swift-module");
  assert.equal(swift?.fixtures?.root, "crates/lightwell-core/fixtures/swift-sample");
  assert.equal(typeof swift?.registerHighlighter, "function");
  const cpp = languagePackForPath("main.cpp");
  assert.equal(cpp?.id, "cpp");
  assert.equal(cpp?.extractor?.kind, "cpp-module");
  assert.equal(cpp?.fixtures?.root, "crates/lightwell-core/fixtures/cpp-sample");
  assert.equal(monacoLanguageIdForPath("main.cpp"), "cpp");
  assert.equal(monacoLanguageIdForPath("greeter.h"), "cpp");
  assert.equal(typeof cpp?.registerHighlighter, "function");
  const configInfra = languagePackForPath("infra/main.tf");
  assert.equal(configInfra?.id, "config-infra");
  assert.equal(configInfra?.extractor?.kind, "config-infra-module");
  assert.equal(configInfra?.fixtures?.root, "crates/lightwell-core/fixtures/config-infra-sample");
  assert.equal(typeof configInfra?.registerHighlighter, "function");
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
  assert.equal(languagePackById("web")?.workspaceExtractor, null);
});
