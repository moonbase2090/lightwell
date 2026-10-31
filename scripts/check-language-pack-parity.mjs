import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const catalogPath = "src/languages/manifests/builtin.language-packs.json";
const bundledSamplePath = "resources/language-packs/demo/language-pack.json";
const workspaceSamplePath = "crates/lightwell-core/fixtures/language-pack-sample/.lightwell/language-packs/demo.language-pack.json";

run(npmCommand(), ["run", "generate:language-packs"]);
run("git", ["diff", "--exit-code", "--", catalogPath]);

assert.deepEqual(
  readJson(bundledSamplePath),
  readJson(workspaceSamplePath),
  "The bundled and workspace sample manifests must remain identical.",
);

run("npx", ["tsx", "--test", "src/language-pack-loader.test.ts"]);
run("cargo", ["test", "-p", "lightwell-core", "--lib", "language_pack::tests", "--locked"]);
run("cargo", ["test", "-p", "lightwell-app", "--bin", "lightwell", "language_packs", "--locked"]);

console.log("Language pack catalogs, samples, and loader behavior are in sync.");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
