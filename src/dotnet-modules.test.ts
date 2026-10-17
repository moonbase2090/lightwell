import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import {
  discoverDotnet,
  parseCsharpSource,
  parseVbSource,
  solutionProjectPaths,
} from "./extract/dotnet-modules.js";
import type { ModuleBlock } from "./model.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/dotnet-sample/", import.meta.url));

test("C# skips comments, strings, and reads partial types", () => {
  const source = `
namespace Sample;
public partial class Real : Other {
    public string Name { get; set; }
    public int Measure(Part item) { return 1; }
}
// class Fake {}
string text = "class Fake2 {}";
string verbatim = @"class Fake3 {}";
string raw = """
class Fake4 {}
""";
`;
  const parsed = parseCsharpSource(source);
  assert.deepEqual(parsed.imports, []);
  assert.deepEqual(parsed.symbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.name), ["Real"]);
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "Measure" && symbol.kind === "method"));
  assert.ok(parsed.symbols.some((symbol) => symbol.memberTypes.some((typeName) => typeName === "Part" || typeName === "string")));
  assert.deepEqual(parsed.symbols.find((symbol) => symbol.name === "Real")?.bases, ["Other"]);
  assert.ok(!parsed.symbols.some((symbol) => symbol.name.startsWith("Fake")));
});

test("a file-scoped C# namespace survives CRLF", () => {
  const parsed = parseCsharpSource("using VbApp;\r\nnamespace A;\r\npublic class B {\r\n public void M() {}\r\n}\r\n");
  assert.equal(parsed.imports[0]?.target, "VbApp");
  assert.equal(parsed.symbols[0]?.name, "B");
  assert.equal(parsed.symbols[0]?.qualified, "A.B");
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "M"));
});

test("VB is case-insensitive and skips comments", () => {
  const source = "Imports CSharpApp\nNamespace VbApp\nPublic CLASS part\nPublic Function Grow(ByVal amount As Integer) As Integer\nReturn amount\nEnd Function\nEnd Class\nEnd Namespace\n' Class Hidden\n";
  const parsed = parseVbSource(source);
  assert.equal(parsed.imports[0]?.target, "CSharpApp");
  assert.ok(parsed.symbols.some((symbol) => symbol.kind === "class" && symbol.namespace === "VbApp" && symbol.name === "part"));
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "Grow" && symbol.kind === "method"));
  assert.ok(!parsed.symbols.some((symbol) => symbol.name === "Hidden"));
});

test("a solution lists both projects", () => {
  const text = readFixture("Sample.sln");
  assert.deepEqual(solutionProjectPaths(text), ["csharp\\CSharpApp.csproj", "vb\\VbApp.vbproj"]);
});

test("the sample solution maps projects, partials, and skips build output", () => {
  const found = discoverDotnet(fixtureRoot);
  assert.deepEqual(found.projects.map((project) => project.name), ["CSharpApp", "VbApp"]);
  assert.ok(found.projects.some((project) => project.name === "CSharpApp" && project.references.some((item) => item.endsWith("VbApp.vbproj"))));
  assert.ok(found.projects.some((project) => project.name === "VbApp" && project.references.some((item) => item.endsWith("CSharpApp.csproj"))));
  assert.ok(!found.files.some((file) => file.path.replaceAll("\\", "/").includes("/bin/") || file.path.replaceAll("\\", "/").includes("/obj/")));
  assert.ok(found.files.some((file) => file.path.endsWith("Extra.CS")));
  assert.equal(found.files.filter((file) => file.symbols.some((symbol) => symbol.name === "Widget" && symbol.partial)).length, 2);
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "DotnetSample" });
  const modules = map.blocks.filter((block): block is ModuleBlock => block.type === "module");
  assert.equal(modules.filter((module) => module.label === "Widget").length, 1);
  assert.ok(modules.some((module) => module.label === "ExtraCase"));
  assert.ok(!modules.some((module) => module.label === "BinOnly" || module.label === "ObjOnly" || module.label === "NotAClass" || module.label === "Hidden"));
  const widget = modules.find((module) => module.label === "Widget");
  const part = modules.find((module) => module.label === "Part" && module.language === "vb");
  const csharp = modules.find((module) => module.cfgAttributes[0] === "project" && module.label === "CSharpApp");
  const vb = modules.find((module) => module.cfgAttributes[0] === "project" && module.label === "VbApp");
  assert.ok(widget);
  assert.ok(part);
  assert.ok(csharp);
  assert.ok(vb);
  assert.equal(widget.cfgAttributes[0], "partial class");
  assert.equal(widget.id, "module:dotnet:type:csharp-csharpapp-csproj:csharpapp-widget");
  assert.ok(dependsOn(map.connections, csharp.id, vb.id));
  assert.ok(dependsOn(map.connections, vb.id, csharp.id));
  assert.ok(dependsOn(map.connections, widget.id, part.id));
  assert.ok(modules.some((module) => module.label === "Measure" && module.parentId === widget.id));
  assert.ok(modules.some((module) => module.label === "Reset" && module.parentId === widget.id));
  assert.ok(modules.some((module) => module.label === "Grow" && module.language === "vb"));
  assert.ok(modules.some((module) => module.label === "Run" && module.cfgAttributes[0] === "method"));
  assert.equal(map.stats.crates, 0);
});

test("invalid UTF-8 is an unresolved file and discovery continues", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-dotnet-utf8-"));
  try {
    writeFileSync(path.join(root, "App.csproj"), "<Project><PropertyGroup><AssemblyName>App</AssemblyName></PropertyGroup></Project>\n");
    writeFileSync(path.join(root, "kept.cs"), "public class Kept {}\n");
    writeFileSync(path.join(root, "bad.cs"), Buffer.from([0xff, 0xfe, 0x63, 0x6c, 0x61, 0x73, 0x73]));
    const found = discoverDotnet(root);
    const bad = found.files.find((file) => file.path.endsWith("bad.cs"));
    assert.ok(bad);
    assert.equal(bad.unreadable, true);
    assert.deepEqual(bad.symbols, []);
    assert.equal(found.files.find((file) => file.path.endsWith("kept.cs"))?.symbols[0]?.name, "Kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink outside the project is not extracted", () => {
  if (!canCreateSymlink()) return;
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-dotnet-link-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "lightwell-dotnet-outside-"));
  try {
    writeFileSync(path.join(outside, "escape.cs"), "public class Escaped {}\n");
    writeFileSync(path.join(root, "kept.cs"), "public class Kept {}\n");
    symlinkSync(path.join(outside, "escape.cs"), path.join(root, "escape.cs"));
    const found = discoverDotnet(root);
    assert.deepEqual(found.files.map((file) => path.basename(file.path)), ["kept.cs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cargo extraction includes C# types without a flag", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-dotnet-cargo-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"cshost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "Widget.cs"), "namespace App;\npublic class Widget {}\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Cs Host" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "csharp" && block.label === "Widget"));
    assert.ok(map.blocks.some((block) => block.type === "crate"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureRoot, name), "utf8");
}

function dependsOn(connections: readonly { readonly kind: string; readonly source: string; readonly target: string }[], source: string, target: string): boolean {
  return connections.some((connection) => connection.kind === "depends_on" && connection.source === source && connection.target === target);
}

function canCreateSymlink(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lightwell-symlink-probe-"));
  try {
    writeFileSync(path.join(dir, "target.txt"), "probe\n");
    symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
