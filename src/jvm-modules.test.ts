import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverJvm, jvmFactBlocks, jvmIdEncode, jvmImportStatement, parseJvmSource } from "./extract/jvm-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/jvm-sample/", import.meta.url));

test("parseJvmSource keeps imports after non-ASCII comments and skips commented declarations", () => {
  const java = parseJvmSource(
    "package com.example.app;\n// 日本語 café\nimport static com.example.lib.Util.greet;\nclass App {}\n",
    "java",
  );
  assert.equal(java.imports.length, 1);
  assert.equal(java.imports[0]?.staticImport, true);
  assert.equal(java.imports[0]?.path, "com.example.lib.Util.greet");
  assert.equal(jvmImportStatement(java.imports[0]!), "import static com.example.lib.Util.greet;");
  assert.equal(java.symbols[0]?.name, "App");
  assert.equal(java.symbols[0]?.line, 4);

  const commented = parseJvmSource("package p;\n/*\nclass Hidden {\n}\n*/\npublic class Shown {}\n", "java");
  assert.deepEqual(commented.symbols.map((symbol) => symbol.name), ["Shown"]);
  assert.equal(commented.symbols[0]?.line, 6);

  const kotlin = parseJvmSource("fun <T> identity(value: T) = value\nfun Greeter.extension() {}\nobject Holder\n", "kotlin");
  assert.deepEqual(
    kotlin.symbols.map((symbol) => [symbol.name, symbol.kind]),
    [["identity", "fun"], ["extension", "fun"], ["Holder", "object"]],
  );

  const nested = parseJvmSource("object Outer {\n    fun nested() {}\n    class Inner\n}\nfun top() {}\n", "kotlin");
  assert.deepEqual(
    nested.symbols.map((symbol) => [symbol.name, symbol.kind]),
    [["Outer", "object"], ["top", "fun"]],
  );
  assert.equal(nested.symbols.some((symbol) => symbol.name === "nested"), false);
  assert.equal(nested.symbols.some((symbol) => symbol.name === "Inner"), false);
});

test("jvmIdEncode preserves ASCII case so Foo and foo stay distinct", () => {
  assert.equal(jvmIdEncode("Foo"), "Foo");
  assert.equal(jvmIdEncode("foo"), "foo");
  assert.notEqual(jvmIdEncode("Foo"), jvmIdEncode("foo"));
  assert.equal(jvmIdEncode("foo-bar"), "foo_2d_bar");
  assert.equal(jvmIdEncode("foo_bar"), "foo_5f_bar");
  const cases = readFileSync(path.join(fixtureRoot, "id-encode-cases.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(cases.includes("Foo") && cases.includes("foo"));
  const encoded = cases.map(jvmIdEncode);
  assert.equal(new Set(encoded).size, encoded.length);
});

test("jvm case-distinct modules keep distinct block ids when the filesystem allows", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-case-"));
  try {
    const probeUpper = path.join(root, "_case_probe_UPPER");
    const probeLower = path.join(root, "_case_probe_upper");
    mkdirSync(probeUpper);
    let caseSensitive = true;
    try {
      mkdirSync(probeLower);
    } catch {
      caseSensitive = false;
    }
    if (!caseSensitive) return;
    writeFileSync(path.join(root, "settings.gradle.kts"), 'include(":Foo", ":foo")\n');
    for (const name of ["Foo", "foo"]) {
      const module = path.join(root, name);
      mkdirSync(path.join(module, "src/main/java/com/example"), { recursive: true });
      writeFileSync(path.join(module, "build.gradle.kts"), "plugins { java }\n");
      writeFileSync(
        path.join(module, "src/main/java/com/example/Item.java"),
        "package com.example;\npublic class Item {}\n",
      );
    }
    const facts = jvmFactBlocks({
      workspace: discoverJvm(root),
      rootPath: root,
      workspaceId: "workspace:case",
    });
    const upper = facts.blocks.find((block) => block.modulePath === "Foo");
    const lower = facts.blocks.find((block) => block.modulePath === "foo");
    assert.equal(upper?.id, "module:jvm:Foo");
    assert.equal(lower?.id, "module:jvm:foo");
    assert.notEqual(upper?.id, lower?.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jvm fixture lists modules, packages, imports, and symbols", () => {
  const workspace = discoverJvm(fixtureRoot);
  assert.deepEqual(
    workspace.modules.map((module) => [module.name, module.kind]),
    [["app", "gradle"], ["foo-bar", "gradle"], ["foo_bar", "gradle"], ["lib", "maven"]],
  );
  const app = workspace.packages.find((pkg) => pkg.name === "com.example.app");
  assert.equal(app?.moduleName, "app");
  const appJava = app?.files.find((file) => file.path.endsWith("App.java"));
  assert.equal(appJava?.language, "java");
  assert.equal(appJava?.test, false);
  assert.equal(appJava?.symbols.length, 1);
  assert.equal(appJava?.symbols[0]?.name, "App");
  assert.equal(appJava?.symbols[0]?.line, 10);
  assert.ok(appJava?.imports.some((item) => !item.staticImport && item.path === "com.example.lib.Util"));
  assert.ok(appJava?.imports.some((item) => item.staticImport && item.path === "com.example.lib.Util.greet"));
  const greeter = app?.files.find((file) => file.path.endsWith("Greeter.kt"));
  assert.equal(greeter?.language, "kotlin");
  assert.equal(greeter?.test, false);
  assert.ok(greeter?.symbols.some((symbol) => symbol.name === "Greeter" && symbol.kind === "object" && symbol.line === 8));
  assert.ok(greeter?.symbols.some((symbol) => symbol.name === "hello" && symbol.kind === "fun" && symbol.line === 12));
  assert.equal(greeter?.symbols.some((symbol) => symbol.name === "nested"), false);
  assert.equal(greeter?.symbols.some((symbol) => symbol.name === "hidden"), false);
  assert.equal(app?.files.find((file) => file.path.endsWith("AppTest.java"))?.test, true);
  assert.equal(app?.files.find((file) => file.path.endsWith("Helper.java"))?.test, true);
  const util = workspace.packages.find((pkg) => pkg.name === "com.example.lib")?.files[0];
  assert.equal(util?.symbols.length, 1);
  assert.equal(util?.symbols[0]?.name, "Util");
  assert.equal(util?.symbols[0]?.line, 3);
  assert.equal(
    workspace.packages.some((pkg) => pkg.files.some((file) => file.path.includes(`${path.sep}build${path.sep}`))),
    false,
  );
});

test("jvm fixture extracts modules, files, symbols, and import edges", () => {
  const workspace = discoverJvm(fixtureRoot);
  const facts = jvmFactBlocks({ workspace, rootPath: fixtureRoot, workspaceId: "workspace:jvm-sample" });
  const appFile = "module:jvm:app_2f_src_2f_main_2f_java_2f_com_2f_example_2f_app_2f_App_2e_java";
  assert.ok(facts.blocks.some((block) => block.id === "module:jvm:app" && block.language === "jvm" && block.cfgAttributes[0] === "gradle"));
  assert.ok(facts.blocks.some((block) => block.id === "module:jvm:lib" && block.cfgAttributes[0] === "maven"));
  assert.ok(facts.blocks.some((block) => block.id === "module:jvm:foo_2d_bar"));
  assert.ok(facts.blocks.some((block) => block.id === "module:jvm:foo_5f_bar"));
  assert.notEqual(
    facts.blocks.find((block) => block.modulePath === "foo-bar")?.id,
    facts.blocks.find((block) => block.modulePath === "foo_bar")?.id,
  );
  assert.ok(facts.blocks.some((block) => block.id === "module:jvm:app:com_2e_example_2e_app" && block.modulePath === "com.example.app"));
  assert.ok(facts.blocks.some((block) => block.id === appFile && block.language === "java" && block.modulePath === "com.example.app/App"));
  assert.ok(facts.blocks.some((block) => block.id === `${appFile}:App:class` && block.cfgAttributes[0] === "class"));
  assert.ok(facts.blocks.some((block) => block.id.endsWith("Greeter_2e_kt:hello:fun") && block.language === "kotlin"));
  assert.equal(facts.blocks.some((block) => block.label === "nested"), false);
  assert.ok(facts.blocks.some((block) => block.id.endsWith("AppTest_2e_java:test")));
  assert.ok(facts.blocks.some((block) => block.id.endsWith("Helper_2e_java:test")));
  const appEdges = facts.connections.filter((edge) => edge.kind === "depends_on" && edge.source === appFile);
  assert.deepEqual(appEdges.map((edge) => edge.target), ["module:jvm:lib:com_2e_example_2e_lib"]);
  assert.equal(facts.blocks.some((block) => block.label === "Skipped"), false);

  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "JVM Sample" });
  assert.equal(map.blocks.find((block) => block.type === "workspace")?.sourcePath, "pom.xml");
  assert.ok(map.blocks.some((block) => block.type === "module" && block.id === "module:jvm:app" && block.language === "jvm"));
  assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "kotlin" && block.modulePath === "com.example.app.hello"));
});

test("discoverJvm returns an empty workspace when no Maven or Gradle file exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-plain-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/App.java"), "public class App {}\n");
    const workspace = discoverJvm(root);
    assert.equal(workspace.modules.length, 0);
    assert.equal(workspace.packages.length, 0);
    assert.throws(() => extractCargoMap({ repositoryPath: root }), /Cargo\.toml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jvm import edges use the longest package prefix", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-prefix-"));
  try {
    writeFileSync(path.join(root, "pom.xml"), "<project><artifactId>prefix</artifactId></project>\n");
    const java = path.join(root, "src/main/java/com/example");
    mkdirSync(path.join(java, "lib"), { recursive: true });
    mkdirSync(path.join(java, "app"), { recursive: true });
    writeFileSync(path.join(java, "Root.java"), "package com.example;\npublic class Root {}\n");
    writeFileSync(path.join(java, "lib/Util.java"), "package com.example.lib;\npublic class Util {}\n");
    writeFileSync(path.join(java, "app/App.java"), "package com.example.app;\nimport com.example.lib.Util;\npublic class App {}\n");
    writeFileSync(path.join(java, "app/Other.java"), "package com.example.app;\nimport com.example.libutil.Foo;\npublic class Other {}\n");
    writeFileSync(path.join(java, "app/Wild.java"), "package com.example.app;\nimport com.example.lib.*;\npublic class Wild {}\n");
    const facts = jvmFactBlocks({
      workspace: discoverJvm(root),
      rootPath: root,
      workspaceId: "workspace:prefix",
    });
    const targetOf = (label: string) => {
      const source = facts.blocks.find((block) =>
        block.language === "java" && block.label === label && block.cfgAttributes.some((item) => item.startsWith("import ")));
      return facts.connections
        .filter((edge) => edge.kind === "depends_on" && edge.source === source?.id)
        .map((edge) => edge.target);
    };
    assert.deepEqual(targetOf("App"), ["module:jvm:prefix:com_2e_example_2e_lib"]);
    assert.deepEqual(targetOf("Wild"), ["module:jvm:prefix:com_2e_example_2e_lib"]);
    assert.deepEqual(targetOf("Other"), ["module:jvm:prefix:com_2e_example"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-root Maven and Gradle names ignore commented build metadata", () => {
  const maven = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-demo-"));
  const gradle = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-solo-"));
  try {
    writeFileSync(path.join(maven, "pom.xml"), `<project>
  <parent><artifactId>parent-art</artifactId></parent>
  <artifactId>demo</artifactId>
  <dependencies><dependency><artifactId>jcl</artifactId></dependency></dependencies>
</project>
`);
    mkdirSync(path.join(maven, "src/main/java/com/example"), { recursive: true });
    writeFileSync(path.join(maven, "src/main/java/com/example/Demo.java"), "package com.example;\npublic class Demo {}\n");
    const mavenWorkspace = discoverJvm(maven);
    assert.equal(mavenWorkspace.modules.length, 1);
    assert.equal(mavenWorkspace.modules[0]?.name, "demo");
    assert.equal(mavenWorkspace.modules[0]?.kind, "maven");

    writeFileSync(path.join(gradle, "settings.gradle.kts"), "// rootProject.name = \"nope\"\nrootProject.name = \"solo\"\n// include(\":skipped\")\n");
    writeFileSync(path.join(gradle, "build.gradle.kts"), "// solo\n");
    mkdirSync(path.join(gradle, "src/main/kotlin/com/example"), { recursive: true });
    writeFileSync(
      path.join(gradle, "src/main/kotlin/com/example/Note.kts"),
      "/*\npackage com.evil\n*/\npackage com.example\n\nfun setup() {}\n",
    );
    mkdirSync(path.join(gradle, "build"));
    writeFileSync(path.join(gradle, "build/Skipped.kt"), "package skipped\nclass Skipped\n");
    const gradleWorkspace = discoverJvm(gradle);
    assert.equal(gradleWorkspace.modules.length, 1);
    assert.equal(gradleWorkspace.modules[0]?.name, "solo");
    assert.equal(gradleWorkspace.modules[0]?.kind, "gradle");
    assert.equal(gradleWorkspace.packages[0]?.name, "com.example");
    assert.equal(gradleWorkspace.packages[0]?.files[0]?.language, "kotlin");
    assert.equal(gradleWorkspace.packages[0]?.files[0]?.symbols[0]?.name, "setup");
    assert.equal(gradleWorkspace.packages[0]?.files[0]?.symbols[0]?.line, 6);
  } finally {
    rmSync(maven, { recursive: true, force: true });
    rmSync(gradle, { recursive: true, force: true });
  }
});

test("jvm discovery skips generated directories and keeps invalid UTF-8 files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-skip-"));
  try {
    writeFileSync(path.join(root, "pom.xml"), "<project><artifactId>skip</artifactId></project>\n");
    mkdirSync(path.join(root, "src/main/java/com/example"), { recursive: true });
    writeFileSync(path.join(root, "src/main/java/com/example/Kept.java"), "package com.example;\npublic class Kept {}\n");
    writeFileSync(path.join(root, "src/main/java/Broken.java"), Buffer.from([0xff, 0xfe, 0x00]));
    for (const name of ["build", "target", "node_modules", "vendor", "testdata", "dist", "out", ".gradle", ".git"]) {
      mkdirSync(path.join(root, name, "src/main/java"), { recursive: true });
      writeFileSync(path.join(root, name, "pom.xml"), `<project><artifactId>${name}</artifactId></project>\n`);
      writeFileSync(path.join(root, name, "src/main/java/Hidden.java"), `public class Hidden${name.replaceAll(".", "")} {}\n`);
    }
    const workspace = discoverJvm(root);
    assert.equal(workspace.modules.length, 1);
    assert.equal(workspace.modules[0]?.name, "skip");
    const names = workspace.packages.flatMap((pkg) => pkg.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)));
    assert.deepEqual(names, ["Kept"]);
    const broken = workspace.packages.flatMap((pkg) => pkg.files).find((file) => file.path.endsWith("Broken.java"));
    assert.equal(broken?.unreadable, true);
    assert.equal(broken?.language, "java");
    assert.equal(broken?.symbols.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("groovy include lines discover a Gradle module", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-jvm-groovy-"));
  try {
    writeFileSync(path.join(root, "settings.gradle"), "include ':leaf'\n");
    mkdirSync(path.join(root, "leaf/src/main/java/com/example"), { recursive: true });
    writeFileSync(path.join(root, "leaf/build.gradle"), "// leaf\n");
    writeFileSync(path.join(root, "leaf/src/main/java/com/example/Leaf.java"), "package com.example;\npublic class Leaf {}\n");
    const workspace = discoverJvm(root);
    assert.equal(workspace.modules.length, 1);
    assert.equal(workspace.modules[0]?.name, "leaf");
    assert.equal(workspace.modules[0]?.kind, "gradle");
    assert.equal(workspace.packages.some((pkg) => pkg.name === "com.example"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
