import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";

function bashCommand(): string {
  if (existsSync(gitBash)) return gitBash;
  return "bash";
}

export function readRepoText(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

export function execScript(
  script: string,
  args: readonly string[],
  options: ExecFileSyncOptions & { encoding: "utf8" },
): string {
  const result =
    process.platform === "win32"
      ? execFileSync(bashCommand(), [script, ...args], options)
      : execFileSync(script, [...args], options);
  return String(result);
}

let python: string | undefined;

export function pythonCommand(): string {
  if (python) return python;
  const names = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const name of names) {
    try {
      execFileSync(name, ["-c", "import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)"], {
        stdio: "ignore",
      });
      python = name;
      return name;
    } catch {
      // Try the next command name.
    }
  }
  throw new Error("Python 3 is required to build release-text fixtures");
}
