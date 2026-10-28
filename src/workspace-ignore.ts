import workspaceIgnoredDirectoryNames from "../shared/workspace-ignored-directories.json";

const normalizedIgnoredDirectoryNames: ReadonlySet<string> = new Set(
  workspaceIgnoredDirectoryNames.map((name) => name.toLowerCase()),
);

const noAdditionalDirectories: readonly string[] = [];

export function isIgnoredDirectory(
  name: string,
  additionalNames: readonly string[] = noAdditionalDirectories,
): boolean {
  const normalizedName = name.toLowerCase();
  return normalizedIgnoredDirectoryNames.has(normalizedName)
    || additionalNames.some((additionalName) => additionalName.toLowerCase() === normalizedName);
}

export function pathContainsIgnoredDirectory(path: string): boolean {
  return path.split(/[\\/]/).some((part) => isIgnoredDirectory(part));
}
