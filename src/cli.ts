#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractCargoMap } from "./extract/cargo.js";

function usage(): never {
  throw new Error([
    "Usage:",
    "  lightwell extract <repository> -o <facts.json> [--name <label>]",
    "  lightwell help",
  ].join("\n"));
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function run(args: readonly string[]): void {
  const [command, ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    console.log("Usage: lightwell extract <repository> -o <facts.json> [--name <label>]");
    return;
  }
  if (command !== "extract") usage();

  const repositoryPath = rest[0];
  const output = optionValue(rest, "-o") ?? optionValue(rest, "--output");
  if (repositoryPath === undefined || output === undefined) usage();
  const name = optionValue(rest, "--name");
  const map = extractCargoMap({ repositoryPath, projectName: name });
  const outputPath = path.resolve(output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  console.log(`Wrote ${map.stats.blocks} blocks and ${map.stats.connections} connections to ${path.relative(process.cwd(), outputPath)}`);
}

try {
  run(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "lightwell failed");
  process.exitCode = 1;
}
