import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cases = [
  {
    label: "Prismattyc",
    repository: "https://github.com/moonbase2090/Prismattyc.git",
    revision: "c91e566e9e1b974a719eeabb9d4e1e439b625b58",
    facts: "maps/prismattyc.facts.json",
  },
  {
    label: "Scorecard",
    repository: "https://github.com/moonbase2090/Scorecard.git",
    revision: "12a723aa998fac4bd9d5e16bf6d6ae40819bb7a3",
    facts: "maps/scorecard.facts.json",
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result.stdout;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findDifferences(actual, expected, location = "$", differences = []) {
  if (Object.is(actual, expected) || differences.length === 25) return differences;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      differences.push(`${location}: array shape differs`);
      return differences;
    }
    if (actual.length !== expected.length) {
      differences.push(`${location}: expected ${expected.length} items, got ${actual.length}`);
      return differences;
    }
    for (let index = 0; index < actual.length; index += 1) {
      findDifferences(actual[index], expected[index], `${location}[${index}]`, differences);
      if (differences.length === 25) return differences;
    }
    return differences;
  }
  if (isRecord(actual) || isRecord(expected)) {
    if (!isRecord(actual) || !isRecord(expected)) {
      differences.push(`${location}: object shape differs`);
      return differences;
    }
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(actual, key)) {
        differences.push(`${location}.${key}: key missing from actual output`);
      } else if (!Object.hasOwn(expected, key)) {
        differences.push(`${location}.${key}: unexpected key in actual output`);
      } else {
        findDifferences(actual[key], expected[key], `${location}.${key}`, differences);
      }
      if (differences.length === 25) return differences;
    }
    return differences;
  }
  differences.push(`${location}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return differences;
}

function assertEqual(actual, expected, description) {
  const differences = findDifferences(actual, expected);
  if (differences.length > 0) {
    const suffix = differences.length === 25 ? "\nFurther differences omitted." : "";
    throw new Error(`${description}:\n${differences.join("\n")}${suffix}`);
  }
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "lightwell-map-parity-"));
const noCargoPath = path.join(temporaryRoot, "no-cargo");
mkdirSync(noCargoPath);
try {
  for (const fixture of cases) {
    const checkout = path.join(temporaryRoot, fixture.label);
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", fixture.repository, checkout]);
    run("git", ["-C", checkout, "checkout", "--quiet", "--detach", fixture.revision]);
    const cargoOutput = run("cargo", [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "lightwell-core",
      "--example",
      "extract_map",
      "--",
      checkout,
    ]);
    const noCargoExecutable = path.join(
      root,
      "target",
      "debug",
      "examples",
      process.platform === "win32" ? "extract_map.exe" : "extract_map",
    );
    const noCargoOutput = run(noCargoExecutable, [checkout], {
      env: { ...process.env, PATH: noCargoPath },
    });
    const actual = JSON.parse(cargoOutput);
    const withoutCargo = JSON.parse(noCargoOutput);
    const expected = JSON.parse(readFileSync(path.join(root, fixture.facts), "utf8"));
    assertEqual(actual, expected, `Rust extraction differs from ${fixture.facts}`);
    assertEqual(withoutCargo, actual, `No-Cargo extraction differs for ${fixture.label}`);
    console.log(
      `Cargo and no-Cargo extraction match ${fixture.facts}: ${actual.stats.blocks} blocks and ${actual.stats.connections} connections (${fixture.revision.slice(0, 12)}).`,
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
