import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverTypeScriptModules, parseTypeScriptSource } from "./extract/typescript-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/typescript-sample/", import.meta.url));

test("typescript fixture lists modules, imports, and top-level symbols", () => {
  const modules = discoverTypeScriptModules(fixtureRoot);
  const lib = modules.find((module) => module.name === "lib");
  assert.ok(lib);
  assert.ok(lib.imports.some((item) => item.statement.includes("node:fs/promises")));
  assert.deepEqual(lib.symbols.map((symbol) => [symbol.name, symbol.kind]), [
    ["loadConfig", "function"],
    ["Widget", "class"],
    ["Options", "type"],
  ]);
  const worker = modules.find((module) => module.name === "nested.worker");
  assert.ok(worker);
  assert.deepEqual(worker.symbols.map((symbol) => symbol.name), ["run"]);
});

test("multiline import is stored with the from clause", () => {
  const parsed = parseTypeScriptSource("import {\n  readFile,\n} from \"node:fs/promises\";\n");
  assert.equal(parsed.imports.length, 1);
  assert.match(parsed.imports[0]?.statement ?? "", /from "node:fs\/promises"/);
});

test("export inside jsx is not a separate top-level symbol", () => {
  const parsed = parseTypeScriptSource(`export function Page() {
  return (
    <div>
export function Fake() {}
    </div>
  );
}
`);
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ["Page"]);
});

test("comparison and shift operators do not block later exports", () => {
  const parsed = parseTypeScriptSource(`export const min = a < b ? a : b;
export function next() {}
const gap = 1 << 2;
export class Tail {}
`);
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ["min", "next", "Tail"]);
});

test("export inside a string is not a top-level symbol", () => {
  const parsed = parseTypeScriptSource('const text = "export function fake() {}";\nexport function real() {}\n');
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ["real"]);
});

test("cargo extraction includes typescript modules by default", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-typescript-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"tshost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "api.ts"), "export function load() {}\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "TS Host" });
    const typescript = map.blocks.filter((block) => block.type === "module" && block.language === "typescript");
    assert.ok(typescript.some((block) => block.modulePath === "api"));
    assert.ok(typescript.some((block) => block.modulePath === "api.load"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
