import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractCargoMap } from "../src/extract/cargo.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "crates/lightwell-core/fixtures/config-infra-sample");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "lightwell-config-infra-parity-"));
const rustMapPath = path.join(temporaryRoot, "rust-map.json");
try {
  const result = spawnSync("cargo", [
    "run", "--quiet", "--locked", "-p", "lightwell-cli", "--",
    "extract", fixtureRoot, "-o", rustMapPath, "--name", "ConfigInfra",
  ], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n").trim());
  const rustMap: unknown = JSON.parse(readFileSync(rustMapPath, "utf8"));
  const typescriptMap = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "ConfigInfra" });
  assert.deepEqual(typescriptMap, rustMap, "Rust and TypeScript config/infra maps should match");
  console.log(`Rust and TypeScript config/infra maps match: ${typescriptMap.stats.blocks} blocks and ${typescriptMap.stats.connections} connections.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
