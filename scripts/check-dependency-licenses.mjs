#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = execFileSync("npm", ["ls", "--all", "--parseable", "--omit=optional"], {
  cwd: projectRoot,
  encoding: "utf8",
}).trim().split(/\r?\n/).filter((directory) => path.resolve(directory) !== projectRoot);
const byLicense = new Map();
for (const directory of packageDirectories) {
  try {
    const packageInfo = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    const license = typeof packageInfo.license === "string" ? packageInfo.license : "UNKNOWN";
    const names = byLicense.get(license) ?? [];
    names.push(packageInfo.name);
    byLicense.set(license, names);
  } catch {
    continue;
  }
}

for (const [license, packages] of [...byLicense.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const uniqueNames = [...new Set(packages)].sort((left, right) => left.localeCompare(right));
  console.log(`${license}\t${uniqueNames.join(", ")}`);
}
