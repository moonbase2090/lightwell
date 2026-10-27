import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverSwiftTargets, parseSwiftSource, swiftFactBlocks } from "./extract/swift-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/swift-sample/", import.meta.url));

test("parseSwiftSource records import modules and keeps symbol lines after block comments", () => {
  const withKind = parseSwiftSource("import struct Foundation.Date\n");
  assert.equal(withKind.imports.length, 1);
  assert.equal(withKind.imports[0]?.module, "Foundation");
  const withBlock = parseSwiftSource("/* block\n   comment */\npublic struct After {}\n");
  assert.equal(withBlock.symbols.length, 1);
  assert.equal(withBlock.symbols[0]?.line, 3);
  assert.equal(withBlock.symbols[0]?.name, "After");
});

test("swift fixture lists targets, imports, and top-level symbols", () => {
  const targets = discoverSwiftTargets(fixtureRoot);
  assert.ok(targets.some((target) => target.name === "Greeting"));
  assert.ok(targets.some((target) => target.name === "Demo"));
  const greeting = targets.find((target) => target.name === "Greeting");
  assert.ok(greeting?.files.some((file) => file.imports.some((item) => item.module === "Foundation")));
  assert.ok(greeting?.files.some((file) => file.symbols.some((symbol) => symbol.name === "Greeter" && symbol.kind === "struct")));
  assert.ok(greeting?.files.some((file) => file.symbols.some((symbol) => symbol.name === "greet" && symbol.kind === "func")));
  const demo = targets.find((target) => target.name === "Demo");
  assert.ok(demo?.files.some((file) => file.imports.some((item) => item.module === "Greeting")));
});

test("swift fixture extracts targets, files, symbols, and import edges", () => {
  const targets = discoverSwiftTargets(fixtureRoot);
  const facts = swiftFactBlocks({ targets, rootPath: fixtureRoot, workspaceId: "workspace:swift-sample" });
  const swift = facts.blocks;
  assert.ok(swift.some((block) => block.type === "module" && block.modulePath === "SwiftSample/Greeting"));
  assert.ok(swift.some((block) => block.type === "module" && block.modulePath === "SwiftSample/Greeting/Greeter"));
  assert.ok(swift.some((block) => block.type === "module" && block.modulePath === "SwiftSample/Greeting/Greeter.Greeter"));
  assert.ok(swift.some((block) => block.type === "module" && block.modulePath === "SwiftSample/Greeting/Greeter.greet"));
  assert.ok(
    facts.connections.some(
      (edge) =>
        edge.kind === "depends_on"
        && edge.source.includes("demo")
        && edge.target.includes("greeting"),
    ),
    "Demo should depend on Greeting via import",
  );
});

test("cargo extraction includes swift modules when Package.swift is present", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-swift-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "Sources", "Lib"), { recursive: true });
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"swifthost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(
      path.join(root, "Package.swift"),
      'let package = Package(\n    name: "Host",\n    targets: [\n        .target(name: "Lib"),\n    ]\n)\n',
    );
    writeFileSync(path.join(root, "Sources/Lib/Lib.swift"), "public struct Lib {}\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Swift Host" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "swift" && block.modulePath === "Host/Lib"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "swift" && block.modulePath === "Host/Lib/Lib"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "swift" && block.modulePath === "Host/Lib/Lib.Lib"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Package.swift alone opens a workspace without Cargo.toml", () => {
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "Swift Sample" });
  assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "swift"));
  assert.equal(map.project.name, "Swift Sample");
});

test("swift workspace fingerprint matches Rust swift:target:basename:hash format", () => {
  const targets = discoverSwiftTargets(fixtureRoot);
  assert.ok(targets.length > 0);
  const expectedInputs = targets
    .flatMap((target) =>
      target.files.map((file) => {
        const hash = createHash("sha256").update(readFileSync(file.path)).digest("hex");
        return `swift:${target.name}:${path.basename(file.path)}:${hash}`;
      }),
    )
    .sort()
    .join("\n");
  const expected = createHash("sha256").update(expectedInputs).digest("hex");
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "Swift Sample" });
  const workspace = map.blocks.find((block) => block.type === "workspace");
  assert.equal(workspace?.fingerprint, expected);
  assert.match(expectedInputs, /swift:Greeting:Greeter\.swift:[0-9a-f]{64}/);
  assert.match(expectedInputs, /swift:Demo:main\.swift:[0-9a-f]{64}/);
});

test("xcodeproj without Package.swift discovers targets and files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-swift-xcode-"));
  try {
    mkdirSync(path.join(root, "DemoApp.xcodeproj"));
    mkdirSync(path.join(root, "App"), { recursive: true });
    writeFileSync(path.join(root, "App", "Content.swift"), "import Foundation\npublic struct Content {}\n");
    const targets = discoverSwiftTargets(root);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.name, "App");
    assert.equal(targets[0]?.packageName, "DemoApp");
    assert.ok(targets[0]?.files.some((file) => path.basename(file.path) === "Content.swift"));
    assert.ok(
      targets[0]?.files.some((file) =>
        file.symbols.some((symbol) => symbol.name === "Content" && symbol.kind === "struct"),
      ),
    );
    const map = extractCargoMap({ repositoryPath: root, projectName: "Xcode Demo" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "swift" && block.modulePath === "DemoApp/App"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "swift" && block.modulePath?.includes("Content")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
