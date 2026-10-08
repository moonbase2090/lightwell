import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const text = readFileSync(new URL("../.github/workflows/rookrunner.yml", import.meta.url), "utf8");

function jobBlock(id: string): string {
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, id);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n  [a-z]/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("linux jobs run on ubuntu-latest and call the existing scripts", () => {
  const jobs = ["checks", "linux-cli-x86_64", "linux-cli-aarch64", "tauri-linux-artifact"];
  for (const id of jobs) {
    const block = jobBlock(id);
    assert.match(block, /\n    runs-on: ubuntu-latest\n/);
    assert.match(block, /uses: actions\/checkout@v4\n/);
  }
  assert.match(jobBlock("linux-cli-x86_64"), /x86_64-unknown-linux-gnu/);
  assert.match(jobBlock("linux-cli-aarch64"), /aarch64-unknown-linux-gnu/);
  assert.match(jobBlock("linux-cli-x86_64"), /scripts\/ci\/build-linux-cli\.sh x86_64-unknown-linux-gnu/);
  assert.match(jobBlock("linux-cli-aarch64"), /scripts\/ci\/smoke-linux-al2023\.sh target\/aarch64-unknown-linux-gnu\/release/);
  assert.match(jobBlock("tauri-linux-artifact"), /scripts\/ci\/check-deb-glibc\.sh/);
  assert.match(text, /permissions:\n  contents: read\n/);
});

test("the companion keeps macOS jobs and floating actions out", () => {
  for (const absent of [
    "macos-cli:",
    "tauri-macos-artifact:",
    "dtolnay/rust-toolchain",
    "actions/setup-node",
    "mlugg/setup-zig",
    "actions/upload-artifact",
    "Scorecard/action",
    "ubuntu-22.04",
    "security-events:",
  ]) {
    assert.equal(text.includes(absent), false, absent);
  }
  const uses = [...text.matchAll(/^ {2,}- uses: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(uses)], ["actions/checkout@v4"]);
});
