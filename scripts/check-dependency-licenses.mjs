#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = execFileSync(
  "npm",
  ["ls", "--all", "--parseable", "--omit=optional"],
  { cwd: projectRoot, encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter((directory) => path.resolve(directory) !== projectRoot);
const npmByLicense = new Map();
for (const directory of packageDirectories) {
  try {
    const packageInfo = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    const license = typeof packageInfo.license === "string" ? packageInfo.license : "UNKNOWN";
    const names = npmByLicense.get(license) ?? [];
    names.push(packageInfo.name);
    npmByLicense.set(license, names);
  } catch {
    continue;
  }
}

const cargoMetadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }),
);
const workspaceMembers = new Set(cargoMetadata.workspace_members);
const rustByLicense = new Map();
for (const packageInfo of cargoMetadata.packages) {
  if (workspaceMembers.has(packageInfo.id)) continue;
  const license =
    packageInfo.license ??
    (packageInfo.license_file ? `SEE ${packageInfo.license_file}` : "UNKNOWN");
  const names = rustByLicense.get(license) ?? [];
  names.push(`${packageInfo.name} ${packageInfo.version}`);
  rustByLicense.set(license, names);
}

function printLicenses(title, licenses) {
  console.log(`${title}:`);
  const sortedLicenses = [...licenses.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [license, packages] of sortedLicenses) {
    const uniqueNames = [...new Set(packages)].sort((left, right) => left.localeCompare(right));
    console.log(`${license}\t${uniqueNames.join(", ")}`);
  }
}

printLicenses("npm dependencies by license", npmByLicense);
printLicenses("Rust dependencies by license", rustByLicense);
