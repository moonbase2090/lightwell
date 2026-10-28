import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Lightwell must not fetch npm packages at run time. `npx` resolves and runs a
// package from the registry, so every script and workflow must call a binary
// that `npm ci` installed from the lockfile instead.
const root = fileURLToPath(new URL("..", import.meta.url));
const scanned = ["scripts", ".github"];
const npxCall = /(^|[\s;&|(`$])npx(\s|$)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function npxHits(text: string): string[] {
  return text.split("\n").filter((line) => npxCall.test(line.trim()) || npxCall.test(line));
}

test("no script or workflow calls npx", () => {
  const hits: string[] = [];
  for (const dir of scanned) {
    for (const path of files(join(root, dir))) {
      for (const line of npxHits(readFileSync(path, "utf8"))) {
        hits.push(`${relative(root, path)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("the guard flags an npx call and ignores a local binary", () => {
  assert.deepEqual(npxHits("  npx --yes @tauri-apps/cli@2.12.1 signer sign"), ["  npx --yes @tauri-apps/cli@2.12.1 signer sign"]);
  assert.deepEqual(npxHits("run: npx playwright install"), ["run: npx playwright install"]);
  assert.deepEqual(npxHits("  node_modules/.bin/tauri signer sign"), []);
  assert.deepEqual(npxHits("echo 'uses nonpxname'"), []);
});
