import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverGoPackages, goFactBlocks, parseGoSource } from "./extract/go-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/go-sample/", import.meta.url));

test("parseGoSource survives non-ASCII before imports and keeps symbol lines after block comments", () => {
  const withUnicode = parseGoSource("package p\n// 日本語 café\nimport \"example.com/x\"\n");
  assert.equal(withUnicode.imports.length, 1);
  const withBlock = parseGoSource("package p\n/* block\n   comment */\nfunc After() {}\n");
  assert.equal(withBlock.symbols.length, 1);
  assert.equal(withBlock.symbols[0]?.line, 4);
});

test("go fixture lists packages, imports, and top-level symbols", () => {
  const packages = discoverGoPackages(fixtureRoot);
  assert.ok(packages.some((pkg) => pkg.importPath === "example.com/go-sample/api"));
  const api = packages.find((pkg) => pkg.importPath === "example.com/go-sample/api");
  assert.ok(api?.files.some((file) => file.imports.some((item) => item.path === "example.com/go-sample/util")));
  assert.ok(api?.files.some((file) => file.symbols.some((symbol) => symbol.name === "Greet")));
});

test("go fixture extracts packages, files, and import edges", () => {
  const packages = discoverGoPackages(fixtureRoot);
  const facts = goFactBlocks({ packages, rootPath: fixtureRoot, workspaceId: "workspace:go-sample" });
  const go = facts.blocks;
  assert.ok(go.some((block) => block.type === "module" && block.modulePath === "example.com/go-sample/api"));
  assert.ok(go.some((block) => block.type === "module" && block.modulePath === "example.com/go-sample/api/api"));
  assert.ok(go.some((block) => block.type === "module" && block.modulePath === "example.com/go-sample/api/api.Greet"));
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on"));
  assert.ok(
    facts.connections.some(
      (edge) =>
        edge.kind === "depends_on"
        && edge.source.includes("example-com-go-sample-main")
        && edge.target.includes("greet"),
    ),
    "TypeScript mirror should emit call edges like Rust",
  );
});

test("cargo extraction includes go modules when go.mod is present", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-go-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"gohost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "go.mod"), "module example.com/host\n\ngo 1.22\n");
    writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Go Host" });
    const go = map.blocks;
    assert.ok(go.some((block) => block.type === "module" && block.language === "go" && block.modulePath === "example.com/host"));
    assert.ok(go.some((block) => block.type === "module" && block.language === "go" && block.modulePath === "example.com/host/main"));
    assert.ok(go.some((block) => block.type === "module" && block.language === "go" && block.modulePath === "example.com/host/main.main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
