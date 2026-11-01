import catalogJson from "../language-packs/catalog.json" with { type: "json" };

export interface RepositoryLanguagePack {
  readonly id: string;
  readonly packVersion: string;
  readonly description: string;
  readonly extensions: readonly string[];
}

export interface RepositoryLanguagePackCatalog {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly packs: readonly RepositoryLanguagePack[];
}

export type InstalledLanguagePack = {
  readonly id: string;
  readonly packVersion: string;
  readonly origin: "builtin" | "user" | "workspace";
};

export type CatalogPackStatus =
  | { readonly kind: "available" }
  | { readonly kind: "installed"; readonly installed: InstalledLanguagePack }
  | { readonly kind: "update"; readonly installed: InstalledLanguagePack };

export type CatalogPackAction =
  | { readonly kind: "install"; readonly source: { readonly kind: "catalog"; readonly id: string }; readonly replace: false }
  | { readonly kind: "update"; readonly source: { readonly kind: "catalog"; readonly id: string }; readonly replace: true }
  | { readonly kind: "none" };

export function parseRepositoryLanguagePackCatalog(value: unknown): RepositoryLanguagePackCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRevision(value.revision) || !Array.isArray(value.packs)) {
    throw new Error("The language pack catalog is invalid.");
  }
  const packs = value.packs.map(parseRepositoryLanguagePack);
  if (new Set(packs.map((pack) => pack.id)).size !== packs.length) {
    throw new Error("The language pack catalog contains duplicate ids.");
  }
  return { schemaVersion: 1, revision: value.revision, packs };
}

export function catalogPackStatus(
  pack: RepositoryLanguagePack,
  installedPacks: readonly InstalledLanguagePack[],
): CatalogPackStatus {
  const installed = installedPacks.find((candidate) => candidate.id === pack.id);
  if (installed === undefined) return { kind: "available" };
  if (comparePackVersions(pack.packVersion, installed.packVersion) > 0 && installed.origin === "user") {
    return { kind: "update", installed };
  }
  return { kind: "installed", installed };
}

export function catalogPackAction(
  pack: RepositoryLanguagePack,
  installedPacks: readonly InstalledLanguagePack[],
): CatalogPackAction {
  const status = catalogPackStatus(pack, installedPacks);
  if (status.kind === "available") return { kind: "install", source: { kind: "catalog", id: pack.id }, replace: false };
  if (status.kind === "update") return { kind: "update", source: { kind: "catalog", id: pack.id }, replace: true };
  return { kind: "none" };
}

export function comparePackVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export const REPOSITORY_LANGUAGE_PACK_CATALOG = parseRepositoryLanguagePackCatalog(catalogJson);

function parseRepositoryLanguagePack(value: unknown): RepositoryLanguagePack {
  if (
    !isRecord(value)
    || !isPackId(value.id)
    || !isPackVersion(value.packVersion)
    || typeof value.description !== "string"
    || value.description.trim().length === 0
    || !Array.isArray(value.extensions)
    || !value.extensions.every(isExtension)
    || value.extensions.length === 0
  ) {
    throw new Error("The language pack catalog contains an invalid pack.");
  }
  if (new Set(value.extensions).size !== value.extensions.length) {
    throw new Error(`The language pack catalog contains duplicate extensions for ${value.id}.`);
  }
  return {
    id: value.id,
    packVersion: value.packVersion,
    description: value.description.trim(),
    extensions: value.extensions,
  };
}

function parseVersion(value: string): readonly [number, number, number] {
  if (!isPackVersion(value)) throw new Error(`Invalid language pack version: ${value}`);
  const [major, minor, patch] = value.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid language pack version: ${value}`);
  }
  return [major, minor, patch];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPackId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
}

function isPackVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function isExtension(value: unknown): value is string {
  return typeof value === "string" && /^\.[a-z0-9][a-z0-9+_-]*$/.test(value);
}

