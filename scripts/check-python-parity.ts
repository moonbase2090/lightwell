import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fixtures from "../crates/lightwell-core/fixtures/python-metadata-cases.json";
import { extractCargoMap } from "../src/extract/cargo.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = spawnSync("cargo", ["build", "--quiet", "--locked", "-p", "lightwell-cli"], { cwd: repositoryRoot, encoding: "utf8" });
if (build.error) throw build.error;
assert.equal(build.status, 0, build.stderr);
const target = process.env.CARGO_TARGET_DIR ?? path.join(repositoryRoot, "target");
const cli = path.join(target, "debug", process.platform === "win32" ? "lightwell.exe" : "lightwell");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "lightwell-python-parity-"));
try {
  for (const fixture of fixtures) {
    const root = path.join(temporaryRoot, fixture.name);
    mkdirSync(root);
    for (const [relative, source] of Object.entries(fixture.files)) {
      if (source === undefined) continue;
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const output = path.join(temporaryRoot, `${fixture.name}.json`);
    const result = spawnSync(cli, ["extract", root, "-o", output, "--name", "Python parity"], { encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);
    const rustMap: unknown = JSON.parse(readFileSync(output, "utf8"));
    const typescriptMap = extractCargoMap({ repositoryPath: root, projectName: "Python parity" });
    assert.deepEqual(typescriptMap, rustMap, `full maps differ for ${fixture.name}`);
    console.log(`Python parity passed: ${fixture.name}, ${typescriptMap.blocks.length} blocks`);
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
