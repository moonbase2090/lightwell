import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const binary = process.argv[2];
if (!binary) throw new Error("Pass the lightwell executable path.");

const repository = mkdtempSync(path.join(os.tmpdir(), "lightwell-watch-smoke-"));
const source = path.join(repository, "src");
mkdirSync(source);
writeFileSync(
  path.join(repository, "Cargo.toml"),
  '[package]\nname = "watch-smoke"\nversion = "0.1.0"\nedition = "2021"\n',
);
writeFileSync(path.join(source, "lib.rs"), "pub mod before;\n");
writeFileSync(path.join(source, "before.rs"), "pub fn value() -> u8 { 1 }\n");

const child = spawn(binary, ["watch", repository], { stdio: ["ignore", "pipe", "pipe"] });
const maps = [];
const waiters = [];
let stderr = "";
let stopped = false;
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (stderr += chunk));
child.on("error", rejectWaiters);
child.on("exit", (code, signal) => {
  stopped = true;
  rejectWaiters(new Error(`lightwell watch stopped (${code ?? signal}): ${stderr}`));
});

function rejectWaiters(error) {
  while (waiters.length > 0) waiters.shift().reject(error);
}

function nextMap() {
  if (maps.length > 0) return Promise.resolve(maps.shift());
  if (stopped) return Promise.reject(new Error(`lightwell watch stopped: ${stderr}`));
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

createInterface({ input: child.stdout }).on("line", (line) => {
  const map = JSON.parse(line);
  const waiter = waiters.shift();
  if (waiter) waiter.resolve(map);
  else maps.push(map);
});

try {
  const initial = await nextMap();
  assert(initial.blocks.some((block) => block.label === "before"));
  console.log(`initial map: ${initial.blocks.map((block) => block.label).join(", ")}`);

  writeFileSync(path.join(source, "after.rs"), "pub fn value() -> u8 { 2 }\n");
  writeFileSync(path.join(source, "lib.rs"), "pub mod after;\n");
  let timeout;
  const refreshed = await Promise.race([
    nextMap(),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("watch did not emit a refreshed map")), 30_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  assert(refreshed.blocks.some((block) => block.label === "after"));
  assert(!refreshed.blocks.some((block) => block.label === "before"));
  console.log(`refreshed map: ${refreshed.blocks.map((block) => block.label).join(", ")}`);
} finally {
  child.kill("SIGTERM");
  rmSync(repository, { recursive: true, force: true });
}
