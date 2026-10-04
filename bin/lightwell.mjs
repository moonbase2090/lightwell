#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
