import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverPythonModules, parsePythonSource, pythonImportStatement } from "./extract/python-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/python-sample/", import.meta.url));

test("python fixture lists packages, imports, and top-level symbols", () => {
  const modules = discoverPythonModules(fixtureRoot);
  const api = modules.find((module) => module.name === "sample_pkg.api" && !module.stub);
  assert.ok(api);
  assert.equal(api.packageName, "sample_pkg");
  const statements = api.imports.map((item) => pythonImportStatement(item));
  assert.ok(statements.includes("import json"));
  assert.ok(statements.includes("from .nested.worker import run"));
  assert.equal(api.imports.find((item) => item.module === "nested.worker")?.relativeLevel, 1);
  assert.ok(statements.includes("from typing import Optional"));
  assert.deepEqual(api.symbols.map((symbol) => [symbol.name, symbol.kind]), [
    ["load_widget", "def"],
    ["Widget", "class"],
    ["refresh", "async def"],
  ]);
  assert.ok(modules.some((module) => module.name === "sample_pkg"));
  assert.ok(modules.some((module) => module.name === "sample_pkg.nested.worker"));
  const stub = modules.find((module) => module.name === "sample_pkg.types");
  assert.ok(stub);
  assert.equal(stub.stub, true);
  assert.equal(stub.symbols[0]?.name, "Widget");
  assert.equal(stub.symbols[0]?.kind, "class");
  const loose = modules.find((module) => module.name === "loose");
  assert.ok(loose);
  assert.equal(loose.packageName, null);
  assert.equal(loose.symbols[0]?.name, "entry");
});

test("a leading BOM keeps the first function", () => {
  const parsed = parsePythonSource("\uFEFFdef load_widget():\n    return None\n");
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ["load_widget"]);
});

test("invalid UTF-8 is an unresolved Python module and discovery continues", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-python-utf8-"));
  try {
    writeFileSync(path.join(root, "kept.py"), "def kept():\n    return None\n");
    writeFileSync(path.join(root, "bad_source.py"), Buffer.from([0xff, 0xfe, 0x64, 0x65, 0x66]));
    const modules = discoverPythonModules(root);
    const bad = modules.find((module) => module.name === "bad_source");
    assert.ok(bad);
    assert.equal(bad.unreadable, true);
    assert.deepEqual(bad.symbols, []);
    assert.equal(modules.find((module) => module.name === "kept")?.symbols[0]?.name, "kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strings, nested defs, and assignments are not top-level symbols", () => {
  const parsed = parsePythonSource(`"""def not_a_function():
    pass
"""
text = "def still_not_real():"
default = 1
classic = True
def load_widget():
    def hidden():
        return text
`);
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ["load_widget"]);
});

function canCreateSymlink(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lightwell-symlink-probe-"));
  try {
    writeFileSync(path.join(dir, "target.txt"), "probe\n");
    symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a symlink outside the opened root is not a python module", { skip: canCreateSymlink() ? false : "symlink creation is not permitted" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-python-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "lightwell-python-outside-"));
  try {
    writeFileSync(path.join(outside, "escape.py"), "def escaped():\n    return None\n");
    writeFileSync(path.join(root, "kept.py"), "def kept():\n    return None\n");
    symlinkSync(path.join(outside, "escape.py"), path.join(root, "escape.py"));
    const modules = discoverPythonModules(root);
    assert.deepEqual(modules.map((module) => module.name), ["kept"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cargo extraction includes python modules without a flag", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-python-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "sample_pkg"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"pyhost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "sample_pkg/__init__.py"), "");
    writeFileSync(path.join(root, "sample_pkg/api.py"), "def load_widget():\n    return None\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Py Host" });
    const python = map.blocks.filter((block) => block.type === "module" && block.language === "python");
    assert.ok(python.some((block) => block.type === "module" && block.modulePath === "sample_pkg.api"));
    assert.ok(python.some((block) => block.type === "module" && block.modulePath === "sample_pkg.api.load_widget" && block.cfgAttributes[0] === "def"));
    const crateRoot = map.blocks.find((block) => block.type === "module" && block.modulePath === "crate root");
    assert.ok(crateRoot);
    assert.equal(crateRoot.type === "module" ? crateRoot.language : "set", undefined);
    const crates = map.groups.find((group) => group.id === "group:crates");
    assert.ok(crates);
    assert.deepEqual(crates.memberIds, ["crate:pyhost"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
