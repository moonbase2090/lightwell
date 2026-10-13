import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverWebModules, parseTypeScriptSource } from "./extract/web-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/web-sample/", import.meta.url));

test("web fixture lists peers, configs, and routes", () => {
  const modules = discoverWebModules(fixtureRoot);
  const packageJson = modules.find((module) => module.name === "package");
  assert.ok(packageJson);
  assert.equal(packageJson.language, "json");
  assert.ok(packageJson.imports.some((item) => item.statement === "framework vite"));
  assert.ok(modules.some((module) => module.name === "vite.config" && module.language === "typescript"));
  assert.ok(modules.some((module) => module.name === "next.config" && module.language === "javascript"));
  assert.ok(modules.some((module) => module.name === "index" && module.language === "html"));
  assert.ok(modules.some((module) => module.name === "styles.app" && module.language === "css"));
  assert.ok(modules.some((module) => module.name === "styles.theme" && module.language === "scss"));
  assert.ok(modules.some((module) => module.name === "app.page"));
  assert.ok(modules.some((module) => module.name === "pages.about"));
  const appPage = modules.find((module) => module.name === "app.page");
  assert.ok(appPage?.imports.some((item) => item.statement === "next app page"));
  const appLayout = modules.find((module) => module.name === "app.layout");
  assert.ok(appLayout?.imports.some((item) => item.statement === "next app layout"));
  const reactTsx = modules.find((module) => module.name === "src.App");
  assert.equal(reactTsx?.language, "typescript");
  assert.ok(reactTsx?.symbols.some((symbol) => symbol.name === "App"));
  const lib = modules.find((module) => module.name === "src.lib");
  assert.ok(lib);
  assert.deepEqual(lib.symbols.map((symbol) => symbol.name), ["loadConfig", "Widget", "Options"]);
});

test("comparison and shift operators do not block later exports", () => {
  const parsed = parseTypeScriptSource(`export const min = a < b ? a : b;
export function next() {}
`);
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ["min", "next"]);
});

test("cargo extraction includes web modules by default", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-web-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"tshost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "api.ts"), "export function load() {}\n");
    writeFileSync(path.join(root, "legacy.js"), "export function legacy() {}\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Web Host" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "typescript" && block.modulePath === "api"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "javascript" && block.modulePath === "legacy"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
