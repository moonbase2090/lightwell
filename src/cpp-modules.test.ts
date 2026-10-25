import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { cppIdEncode, discoverCppTargets, cppFactBlocks, parseCppSource } from "./extract/cpp-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/cpp-sample/", import.meta.url));

test("cppIdEncode keeps Foo and foo distinct and encodes punctuation", () => {
  assert.equal(cppIdEncode("Foo"), "Foo");
  assert.equal(cppIdEncode("foo"), "foo");
  assert.notEqual(cppIdEncode("Foo"), cppIdEncode("foo"));
  assert.equal(cppIdEncode("lib-a"), "lib_2d_a");
  assert.equal(cppIdEncode("lib_a"), "lib_5f_a");
  assert.notEqual(cppIdEncode("lib-a"), cppIdEncode("lib_a"));
  const cases = ["Foo", "foo", "lib-a", "lib_a", "demo/main", "demo/Main"];
  const encoded = cases.map(cppIdEncode);
  assert.equal(new Set(encoded).size, cases.length);
});

test("parseCppSource lists includes and top-level class/struct/function symbols", () => {
  const source = `
#include "greeter.h"
#include <vector>

// class Fake {}
class Greeter {
public:
    void skip_me();
};

struct Point {
    int x;
};

int helper(int value) {
    return value;
}
`;
  const { includes, symbols } = parseCppSource(source);
  assert.ok(includes.some((item) => !item.system && item.path === "greeter.h"));
  assert.ok(includes.some((item) => item.system && item.path === "vector"));
  assert.ok(symbols.some((symbol) => symbol.name === "Greeter" && symbol.kind === "class"));
  assert.ok(symbols.some((symbol) => symbol.name === "Point" && symbol.kind === "struct"));
  assert.ok(symbols.some((symbol) => symbol.name === "helper" && symbol.kind === "function"));
  assert.equal(symbols.some((symbol) => symbol.name === "skip_me"), false);
  assert.equal(symbols.some((symbol) => symbol.name === "Fake"), false);
});

test("cpp fixture lists targets, files, includes, and symbols", () => {
  const targets = discoverCppTargets(fixtureRoot);
  const demo = targets.find((target) => target.name === "demo");
  assert.equal(demo?.kind, "executable");
  assert.ok(demo?.files.some((file) => path.basename(file.path) === "main.cpp"));
  assert.ok(demo?.files.some((file) => path.basename(file.path) === "greeter.cpp"));
  const main = demo?.files.find((file) => path.basename(file.path) === "main.cpp");
  assert.ok(main?.includes.some((include) => !include.system && include.path === "greeter.h"));
  assert.ok(main?.symbols.some((symbol) => symbol.name === "main" && symbol.kind === "function"));

  const sources = targets.find((target) => target.name === "sources");
  assert.equal(sources?.kind, "interface");
  const greeterH = sources?.files.find((file) => path.basename(file.path) === "greeter.h");
  assert.ok(greeterH?.symbols.some((symbol) => symbol.name === "Greeter" && symbol.kind === "class"));
});

test("cpp fixture extracts targets, files, and quoted-include depends_on edges", () => {
  const targets = discoverCppTargets(fixtureRoot);
  const facts = cppFactBlocks({ targets, rootPath: fixtureRoot, workspaceId: "workspace:cpp-sample" });
  assert.ok(facts.blocks.some((block) => block.language === "cpp" && block.label === "demo"));
  assert.ok(facts.blocks.some((block) => block.language === "cpp" && block.label === "main"));
  assert.ok(
    facts.connections.some(
      (edge) =>
        edge.kind === "depends_on"
        && edge.source.includes("main")
        && edge.target.includes("greeter"),
    ),
    "quoted include should link main.cpp to greeter.h",
  );
});

test("CMakeLists alone opens a workspace map", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-cpp-cmake-"));
  try {
    writeFileSync(path.join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\nproject(Solo)\n");
    writeFileSync(path.join(root, "solo.cpp"), "int main() { return 0; }\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Solo Cpp" });
    assert.equal(map.project.name, "Solo Cpp");
    assert.ok(map.blocks.some((block) => block.type === "workspace"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "cpp"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cargo extraction includes cpp modules when CMakeLists.txt is present", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-cpp-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"cpphost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(
      path.join(root, "CMakeLists.txt"),
      "cmake_minimum_required(VERSION 3.16)\nproject(Host)\nadd_executable(host main.cpp)\n",
    );
    writeFileSync(path.join(root, "main.cpp"), "int main() { return 0; }\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Cpp Host" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "cpp" && block.label === "host"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "cpp" && block.label === "main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmake missing returns empty targets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-cpp-missing-"));
  try {
    writeFileSync(path.join(root, "orphan.cpp"), "int main() { return 0; }\n");
    assert.deepEqual(discoverCppTargets(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
