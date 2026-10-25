import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractCargoMap } from "./extract/cargo.js";
import { discoverRubyPackages, languageIdEncode, parseRubySource, resolveRubyRequire, rubyFactBlocks } from "./extract/ruby-modules.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/ruby-sample/", import.meta.url));

test("parseRubySource skips block comments and methods inside classes", () => {
  const shown = parseRubySource("=begin\nclass Hidden\n=end\nclass Shown\nend\n");
  assert.equal(shown.symbols.length, 1);
  assert.equal(shown.symbols[0]?.name, "Shown");
  assert.equal(shown.symbols[0]?.line, 4);
  assert.equal(shown.symbols[0]?.kind, "class");
  const methods = parseRubySource("module Accounts\n  class User\n    def name\n    end\n  end\nend\ndef user_label\nend\n");
  assert.ok(methods.symbols.some((symbol) => symbol.name === "Accounts" && symbol.kind === "module"));
  assert.ok(methods.symbols.some((symbol) => symbol.name === "User" && symbol.kind === "class"));
  assert.ok(methods.symbols.some((symbol) => symbol.name === "user_label" && symbol.kind === "def"));
  assert.ok(methods.symbols.every((symbol) => symbol.name !== "name"));
});

test("parseRubySource keeps require paths after non-ASCII comments", () => {
  const parsed = parseRubySource("# 日本語 café\nrequire \"json\"\nrequire_relative \"../models/user\"\nclass After\nend\n");
  assert.equal(parsed.imports.length, 2);
  assert.equal(parsed.imports[0]?.path, "json");
  assert.equal(parsed.imports[0]?.relative, false);
  assert.equal(parsed.imports[1]?.relative, true);
  assert.equal(parsed.imports[1]?.path, "../models/user");
  assert.equal(parsed.symbols.length, 1);
  assert.equal(parsed.symbols[0]?.name, "After");
});

test("ruby fixture maps Rails units and skips vendor, tmp, and log", () => {
  const packages = discoverRubyPackages(fixtureRoot);
  assert.ok(packages.every((pkg) => pkg.gemName === "blog"));
  assert.ok(packages.every((pkg) => pkg.files.every((file) => {
    const relative = path.relative(fixtureRoot, file.path);
    return relative.split(path.sep).every((part) => !["vendor", "tmp", "log", ".bundle", "node_modules", ".git"].includes(part));
  })));
  const models = packages.find((pkg) => pkg.importPath === "blog/models");
  assert.ok(models?.files.some((file) =>
    file.moduleSuffix === "user"
    && file.symbols.some((symbol) => symbol.name === "Accounts")
    && file.symbols.some((symbol) => symbol.name === "User")
    && file.symbols.some((symbol) => symbol.name === "user_label")
    && file.symbols.every((symbol) => symbol.name !== "name"),
  ));
  const controllers = packages.find((pkg) => pkg.importPath === "blog/controllers");
  assert.ok(controllers?.files.some((file) =>
    file.imports.some((item) => item.relative && item.path === "../models/user")
    && file.symbols.some((symbol) => symbol.name === "UsersController")
    && file.symbols.every((symbol) => symbol.name !== "index"),
  ));
  assert.ok(packages.some((pkg) => pkg.importPath === "blog/lib"));
  assert.ok(packages.some((pkg) => pkg.importPath === "blog/config"));
});

test("ruby fixture extracts require edges from controllers to models", () => {
  const packages = discoverRubyPackages(fixtureRoot);
  const controllers = packages.find((pkg) => pkg.importPath === "blog/controllers");
  const controller = controllers?.files.find((file) => file.moduleSuffix === "users_controller");
  const resolved = controller === undefined || controller.imports[0] === undefined
    ? null
    : resolveRubyRequire(fixtureRoot, controller.path, controller.imports[0]);
  assert.ok(resolved?.endsWith(`${path.sep}user.rb`) || resolved?.endsWith("/user.rb"));
  const facts = rubyFactBlocks({ packages, rootPath: fixtureRoot, workspaceId: "workspace:ruby-sample" });
  const controllerBlock = facts.blocks.find((block) => block.type === "module" && block.modulePath === "blog/controllers/users_controller");
  const userFile = facts.blocks.find((block) => block.type === "module" && block.modulePath === "blog/models/user");
  const userClass = facts.blocks.find((block) => block.type === "module" && block.modulePath === "blog/models/user.User");
  assert.deepEqual(userClass?.cfgAttributes, ["class"]);
  assert.ok(facts.blocks.some((block) => block.type === "module" && block.modulePath === "blog/models/user.user_label"));
  assert.ok(facts.blocks.every((block) => block.type !== "module" || block.modulePath !== "blog/models/user.name"));
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === controllerBlock?.id && edge.target === userFile?.id));
});

test("rails gem maps models and a plain Gemfile keeps directories", () => {
  const railsRoot = mkdtempSync(path.join(os.tmpdir(), "lightwell-ruby-rails-"));
  const plainRoot = mkdtempSync(path.join(os.tmpdir(), "lightwell-ruby-plain-"));
  try {
    mkdirSync(path.join(railsRoot, "app", "models"), { recursive: true });
    writeFileSync(path.join(railsRoot, "Gemfile"), "gem \"rails\", \"~> 7\"\n");
    writeFileSync(path.join(railsRoot, "app", "models", "user.rb"), "class User\nend\n");
    const railsPackages = discoverRubyPackages(railsRoot);
    const gemName = path.basename(railsRoot);
    assert.ok(railsPackages.some((pkg) => pkg.importPath === `${gemName}/models`));
    assert.ok(railsPackages.every((pkg) => !pkg.importPath.includes("/app/")));

    mkdirSync(path.join(plainRoot, "app", "models"), { recursive: true });
    writeFileSync(path.join(plainRoot, "Gemfile"), "source \"https://rubygems.org\"\n");
    writeFileSync(path.join(plainRoot, "app", "models", "user.rb"), "class User\nend\n");
    const plainPackages = discoverRubyPackages(plainRoot);
    assert.ok(plainPackages.some((pkg) => pkg.importPath === `${path.basename(plainRoot)}/app/models`));
  } finally {
    rmSync(railsRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
  }
});

test("Gemfile alone opens a workspace and records ruby fingerprints", () => {
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "Ruby Sample" });
  const workspace = map.blocks.find((block) => block.type === "workspace");
  assert.equal(workspace?.sourcePath, "Gemfile");
  assert.equal(map.project.name, "Ruby Sample");
  assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "ruby" && block.modulePath === "blog/models/user.User"));
  const packages = discoverRubyPackages(fixtureRoot);
  const inputs = packages.flatMap((pkg) => pkg.files.map((file) => {
    const hash = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    return `ruby:${pkg.importPath}:${path.basename(file.path)}:${hash}`;
  })).sort();
  const expected = createHash("sha256").update(inputs.join("\n")).digest("hex");
  assert.equal(workspace?.fingerprint, expected);
  assert.match(inputs.join("\n"), /ruby:blog\/models:user\.rb:[0-9a-f]{64}/);
  assert.match(inputs.join("\n"), /ruby:blog\/controllers:users_controller\.rb:[0-9a-f]{64}/);
});

test("cargo extraction includes ruby modules when a Gemfile is present", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lightwell-ruby-extract-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "lib"));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"rubyhost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFileSync(path.join(root, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(path.join(root, "Gemfile"), "source \"https://rubygems.org\"\n");
    writeFileSync(path.join(root, "host.gemspec"), "Gem::Specification.new do |spec|\n  spec.name = \"host\"\nend\n");
    writeFileSync(path.join(root, "lib/greeter.rb"), "class Greeter\nend\n");
    const map = extractCargoMap({ repositoryPath: root, projectName: "Ruby Host" });
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "ruby" && block.modulePath === "host/lib"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "ruby" && block.modulePath === "host/lib/greeter"));
    assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "ruby" && block.modulePath === "host/lib/greeter.Greeter"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("for..do does not drop later top-level defs", () => {
  const parsed = parseRubySource(
    "class Before\nend\nfor x in xs do\n  class A\n  end\nend\nmodule Foo\n  class Bar\n  end\nend\ndef top_level\nend\n",
  );
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "Before" && symbol.kind === "class"));
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "A" && symbol.kind === "class"));
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "Foo" && symbol.kind === "module"));
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "Bar" && symbol.kind === "class"));
  assert.ok(
    parsed.symbols.some((symbol) => symbol.name === "top_level" && symbol.kind === "def"),
    "for..do must not leave depth stale so top_level disappears",
  );
});

test("languageIdEncode keeps case and separators distinct for ruby block ids", () => {
  assert.notEqual(languageIdEncode("lib/foo-bar"), languageIdEncode("lib/foo/bar"));
  assert.equal(languageIdEncode("foo-bar"), "foo_2d_bar");
  assert.equal(languageIdEncode("foo_bar"), "foo_5f_bar");
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "Ruby Sample" });
  const ids = map.blocks.filter((block) => block.type === "module" && block.language === "ruby").map((block) => block.id);
  assert.equal(new Set(ids).size, ids.length);
});
