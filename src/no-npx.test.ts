import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Lightwell must not fetch npm packages at run time. Scripts and workflows
// install the lockfile with `npm ci`, then call its scripts or local binaries.
const root = fileURLToPath(new URL("..", import.meta.url));
const scanned = ["scripts", ".github/workflows"];
const forbiddenPackageCommands = [
  /\bnpx(?:\.cmd)?\b/g,
  /\bnpm(?:\.cmd)?\s+(?:install|i|add)\b/g,
  /["']npm(?:\.cmd)?["']\s*,\s*\[\s*["'](?:install|i|add)["']/g,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function packageAcquisitionHits(text: string): string[] {
  const lines = text.split("\n");
  const hitLines = new Set<number>();
  for (const pattern of forbiddenPackageCommands) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      hitLines.add(text.slice(0, match.index).split("\n").length - 1);
    }
  }
  return lines.filter((_, index) => hitLines.has(index));
}

test("scripts and workflows acquire npm packages only through npm ci", () => {
  const hits: string[] = [];
  for (const dir of scanned) {
    for (const path of files(join(root, dir))) {
      for (const line of packageAcquisitionHits(readFileSync(path, "utf8"))) {
        hits.push(`${relative(root, path)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("the guard flags direct and spawned package acquisition", () => {
  const forbidden = [
    "npx --yes @tauri-apps/cli@2.12.1 signer sign",
    'run("npx", ["tsx", "--test"]);',
    "npm install @tauri-apps/cli@2.12.1",
    'run("npm", ["install", "playwright"]);',
  ];
  assert.deepEqual(packageAcquisitionHits(forbidden.join("\n")), forbidden);
});

test("the guard allows lockfile installs and local package commands", () => {
  assert.deepEqual(packageAcquisitionHits([
    "npm ci",
    "npm run test:e2e",
    'run(npmCommand(), ["run", "test:language-packs"]);',
    "node_modules/.bin/tauri signer sign",
    "echo 'uses nonpxname'",
  ].join("\n")), []);
});
