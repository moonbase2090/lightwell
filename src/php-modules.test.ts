import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverPhpPackages, parsePhpSource, phpFactBlocks } from "./extract/php-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/php-sample/", import.meta.url));

test("parsePhpSource keeps symbols after comments and ignores methods", () => {
  const after = parsePhpSource("<?php\n/* block\n   comment */\nclass After {}\n");
  assert.equal(after.symbols.length, 1);
  assert.equal(after.symbols[0]?.name, "After");
  assert.equal(after.symbols[0]?.line, 4);
  const hidden = parsePhpSource("<?php\n// class Fake\n/* class Hidden */\nclass Real {}\n");
  assert.equal(hidden.symbols.length, 1);
  assert.equal(hidden.symbols[0]?.name, "Real");
  const methods = parsePhpSource("<?php\nclass User {\n    public function name(): string { return \"a\"; }\n}\nfunction helper(): void {}\n");
  assert.ok(methods.symbols.some((symbol) => symbol.name === "User" && symbol.kind === "class"));
  assert.ok(methods.symbols.some((symbol) => symbol.name === "helper" && symbol.kind === "function"));
  assert.ok(methods.symbols.every((symbol) => symbol.name !== "name"));
});

test("parsePhpSource reads grouped use aliases after non-ASCII comments", () => {
  const parsed = parsePhpSource("<?php\n// 日本語 café\nnamespace App\\Models;\nuse Foo\\Bar;\nuse App\\Models\\{User, Post as Article};\nuse function App\\Support\\helper as h;\n");
  assert.equal(parsed.namespace, "App\\Models");
  assert.ok(parsed.imports.some((item) => item.qualified === "Foo\\Bar"));
  assert.ok(parsed.imports.some((item) => item.qualified === "App\\Models\\User" && item.alias === null));
  assert.ok(parsed.imports.some((item) => item.qualified === "App\\Models\\Post" && item.alias === "Article"));
  assert.ok(parsed.imports.some((item) => item.qualified === "App\\Support\\helper" && item.statement.startsWith("use function ")));
});

test("php fixture lists namespaces, symbols, and skips vendor", () => {
  const packages = discoverPhpPackages(fixtureRoot);
  assert.ok(packages.every((pkg) => pkg.files.every((file) => !file.path.includes(`${path.sep}vendor${path.sep}`))));
  const models = packages.find((pkg) => pkg.importPath === "acme/blog/App/Models");
  assert.ok(models);
  assert.equal(models?.namespace, "App\\Models");
  assert.ok(models?.files.some((file) =>
    file.symbols.some((symbol) => symbol.name === "User" && symbol.kind === "class")
    && file.symbols.some((symbol) => symbol.name === "user_label")
    && file.symbols.every((symbol) => symbol.name !== "name")
    && file.imports.some((item) => item.qualified === "Acme\\Legacy\\Widget"),
  ));
  assert.ok(models?.files.some((file) => file.path.endsWith("Guest.php") && file.namespace === "App\\Models" && file.symbols.some((symbol) => symbol.name === "Guest")));
  assert.ok(models?.files.some((file) =>
    file.symbols.some((symbol) => symbol.kind === "interface" && symbol.name === "Named")
    && file.symbols.some((symbol) => symbol.kind === "trait" && symbol.name === "Timestamps")
    && file.symbols.some((symbol) => symbol.kind === "enum" && symbol.name === "Status"),
  ));
  const controllers = packages.find((pkg) => pkg.importPath === "acme/blog/App/Http/Controllers");
  assert.ok(controllers?.files.some((file) => file.path.endsWith("HealthController.php") && file.symbols.some((symbol) => symbol.name === "HealthController" && symbol.line === 4)));
  assert.ok(packages.some((pkg) => pkg.namespace === "Acme\\Legacy"));
});

test("php fixture extracts use edges between controllers and models", () => {
  const packages = discoverPhpPackages(fixtureRoot);
  const facts = phpFactBlocks({ packages, rootPath: fixtureRoot, workspaceId: "workspace:php-sample" });
  const controller = facts.blocks.find((block) => block.type === "module" && block.modulePath === "acme/blog/App/Http/Controllers/UserController");
  const user = facts.blocks.find((block) => block.type === "module" && block.modulePath === "acme/blog/App/Models/User.User");
  assert.ok(controller);
  assert.ok(user);
  assert.deepEqual(user?.cfgAttributes, ["class"]);
  assert.ok(facts.blocks.some((block) => block.type === "module" && block.modulePath === "acme/blog/App/Models/User.user_label"));
  assert.ok(facts.blocks.some((block) => block.type === "module" && block.modulePath === "acme/blog/Acme/Legacy/Widget.Widget"));
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === controller?.id && edge.target === user?.id));
});

test("laravel signals map models and controllers without psr-4", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-php-laravel-"));
  try {
    mkdirSync(path.join(root, "app", "Models"), { recursive: true });
    mkdirSync(path.join(root, "app", "Http", "Controllers"), { recursive: true });
    writeFileSync(path.join(root, "composer.json"), "{\n  \"name\": \"acme/laravel\"\n}\n");
    writeFileSync(path.join(root, "artisan"), "#!/usr/bin/env php\n");
    writeFileSync(path.join(root, "app", "Models", "Post.php"), "<?php\nclass Post {}\n");
    writeFileSync(path.join(root, "app", "Http", "Controllers", "PostController.php"), "<?php\nclass PostController {}\n");
    const packages = discoverPhpPackages(root);
    assert.ok(packages.some((pkg) => pkg.importPath === "acme/laravel/App/Models" && pkg.namespace === "App\\Models"));
    assert.ok(packages.some((pkg) => pkg.importPath === "acme/laravel/App/Http/Controllers" && pkg.namespace === "App\\Http\\Controllers"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plain composer does not invent Laravel namespaces", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-php-plain-"));
  try {
    mkdirSync(path.join(root, "app", "Models"), { recursive: true });
    writeFileSync(path.join(root, "composer.json"), "{\n  \"name\": \"acme/plain\"\n}\n");
    writeFileSync(path.join(root, "app", "Models", "Post.php"), "<?php\nclass Post {}\n");
    const packages = discoverPhpPackages(root);
    assert.equal(packages.length, 1);
    assert.equal(packages[0]?.importPath, "acme/plain");
    assert.equal(packages[0]?.namespace, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composer.json alone opens a workspace and records php fingerprints", () => {
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "PHP Sample" });
  const workspace = map.blocks.find((block) => block.type === "workspace");
  assert.equal(workspace?.sourcePath, "composer.json");
  assert.equal(map.project.name, "PHP Sample");
  assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "php" && block.modulePath === "acme/blog/App/Models/User.User"));
  const packages = discoverPhpPackages(fixtureRoot);
  const inputs = packages.flatMap((pkg) => pkg.files.map((file) => {
    const hash = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    return `php:${pkg.importPath}:${path.basename(file.path)}:${hash}`;
  })).sort();
  const expected = createHash("sha256").update(inputs.join("\n")).digest("hex");
  assert.equal(workspace?.fingerprint, expected);
  assert.match(inputs.join("\n"), /php:acme\/blog\/App\/Models:User\.php:[0-9a-f]{64}/);
  assert.match(inputs.join("\n"), /php:acme\/blog\/App\/Http\/Controllers:UserController\.php:[0-9a-f]{64}/);
});

test("cargo extraction includes php modules when composer.json is present", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-php-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"phphost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "composer.json"), "{\n  \"name\": \"acme/host\"\n}\n");
    writeFileSync(path.join(root, "src/Demo.php"), "<?php\nnamespace Acme;\nclass Demo {}\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "PHP Host" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "php" && block.modulePath === "acme/host/Acme"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "php" && block.modulePath === "acme/host/Acme/Demo"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "php" && block.modulePath === "acme/host/Acme/Demo.Demo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
