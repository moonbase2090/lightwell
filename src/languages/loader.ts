import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BUILTIN_LANGUAGE_PACKS } from "./builtin-packs.js";
import type {
  LanguagePack,
  LanguagePackHookRegistry,
  LanguagePackManifestV1,
} from "./language-pack.js";
import {
  EMPTY_LANGUAGE_PACK_HOOKS,
  LanguagePackConflictError,
  LanguagePackManifestError,
  languagePackFromManifest,
  parseLanguagePackManifest,
} from "./manifest.js";
import { createLanguagePackRegistry } from "./registry.js";

export type LanguagePackOrigin = "builtin" | "user" | "workspace";
export type LanguagePackErrorCode = "read" | "parse" | "validation" | "conflict" | "unknown-hook";

export interface LoadedLanguagePackCatalogEntry {
  readonly kind: "loaded";
  readonly id: string;
  readonly packVersion: string;
  readonly origin: LanguagePackOrigin;
  readonly manifestPath: string | null;
  readonly manifest: LanguagePackManifestV1;
}

export interface InvalidLanguagePackCatalogEntry {
  readonly kind: "error";
  readonly errorId: string;
  readonly origin: Exclude<LanguagePackOrigin, "builtin">;
  readonly manifestPath: string;
  readonly code: LanguagePackErrorCode;
  readonly message: string;
}

export type LanguagePackCatalogEntry = LoadedLanguagePackCatalogEntry | InvalidLanguagePackCatalogEntry;

export interface LanguagePackCatalog {
  readonly revision: number;
  readonly userPacksDirectory: string;
  readonly entries: readonly LanguagePackCatalogEntry[];
}

export interface LanguagePackLoadResult {
  readonly packs: readonly LanguagePack[];
  readonly catalog: LanguagePackCatalog;
}

export interface LoadLanguagePackArgs {
  readonly repositoryPath?: string;
  readonly userPacksDirectory?: string | null;
  readonly workspacePacksDirectory?: string | null;
  readonly builtins?: readonly LanguagePack[];
  readonly hooks?: LanguagePackHookRegistry;
  readonly revision?: number;
}

interface ManifestCandidate {
  readonly origin: "user" | "workspace";
  readonly manifestPath: string;
}

export function defaultUserLanguagePacksDirectory(): string {
  return process.env.LIGHTWELL_LANGUAGE_PACKS_DIR ?? path.join(homedir(), ".lightwell", "language-packs");
}

export function loadLanguagePacks(args: LoadLanguagePackArgs = {}): LanguagePackLoadResult {
  const builtins = args.builtins ?? BUILTIN_LANGUAGE_PACKS;
  const hooks = args.hooks ?? EMPTY_LANGUAGE_PACK_HOOKS;
  const userPacksDirectory = args.userPacksDirectory === undefined
    ? defaultUserLanguagePacksDirectory()
    : args.userPacksDirectory;
  const workspacePacksDirectory = args.workspacePacksDirectory === undefined
    ? args.repositoryPath === undefined ? null : path.join(args.repositoryPath, ".lightwell", "language-packs")
    : args.workspacePacksDirectory;
  createLanguagePackRegistry(builtins);
  const packs = [...builtins];
  const entries: LanguagePackCatalogEntry[] = builtins.map((pack) => ({
    kind: "loaded",
    id: pack.id,
    packVersion: pack.packVersion,
    origin: "builtin",
    manifestPath: null,
    manifest: manifestForLanguagePack(pack),
  }));
  const candidates: ManifestCandidate[] = [];
  if (userPacksDirectory !== null) candidates.push(...manifestCandidates(userPacksDirectory, "user"));
  if (workspacePacksDirectory !== null) candidates.push(...manifestCandidates(workspacePacksDirectory, "workspace"));

  for (const candidate of candidates) {
    try {
      const input = readManifest(candidate.manifestPath);
      const manifest = parseLanguagePackManifest(input, candidate.manifestPath);
      const pack = languagePackFromManifest({ manifest, hooks, source: candidate.manifestPath });
      createLanguagePackRegistry([...packs, pack]);
      packs.push(pack);
      entries.push({
        kind: "loaded",
        id: pack.id,
        packVersion: pack.packVersion,
        origin: candidate.origin,
        manifestPath: candidate.manifestPath,
        manifest,
      });
    } catch (error) {
      entries.push(errorEntry(candidate, error));
    }
  }

  return {
    packs,
    catalog: {
      revision: args.revision ?? 0,
      userPacksDirectory: userPacksDirectory ?? "",
      entries,
    },
  };
}

function manifestCandidates(directory: string, origin: ManifestCandidate["origin"]): ManifestCandidate[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectory(error)) return [];
    return [{ origin, manifestPath: directory }];
  }
  const candidates: ManifestCandidate[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && entry.name.endsWith(".language-pack.json")) {
      candidates.push({ origin, manifestPath: path.join(directory, entry.name) });
    } else if (entry.isDirectory()) {
      const manifestPath = path.join(directory, entry.name, "language-pack.json");
      try {
        readFileSync(manifestPath);
        candidates.push({ origin, manifestPath });
      } catch (error) {
        if (!isMissingDirectory(error)) candidates.push({ origin, manifestPath });
      }
    }
  }
  return candidates;
}

function readManifest(manifestPath: string): unknown {
  let source: string;
  try {
    source = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new LanguagePackFileError("read", manifestPath, errorMessage(error));
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new LanguagePackFileError("parse", manifestPath, errorMessage(error));
  }
}

class LanguagePackFileError extends Error {
  readonly code: "read" | "parse";

  constructor(code: "read" | "parse", manifestPath: string, detail: string) {
    super(`Could not ${code === "read" ? "read" : "parse"} language pack manifest ${manifestPath}: ${detail}`);
    this.name = "LanguagePackFileError";
    this.code = code;
  }
}

function errorEntry(candidate: ManifestCandidate, error: unknown): InvalidLanguagePackCatalogEntry {
  const code = errorCode(error);
  return {
    kind: "error",
    errorId: `${candidate.origin}:${candidate.manifestPath}`,
    origin: candidate.origin,
    manifestPath: candidate.manifestPath,
    code,
    message: errorMessage(error),
  };
}

function errorCode(error: unknown): LanguagePackErrorCode {
  if (error instanceof LanguagePackFileError) return error.code;
  if (error instanceof LanguagePackConflictError) return "conflict";
  if (error instanceof LanguagePackManifestError && error.message.includes("is not installed")) return "unknown-hook";
  return "validation";
}

export function manifestForLanguagePack(pack: LanguagePack): LanguagePackManifestV1 {
  return {
    schemaVersion: 1,
    id: pack.id,
    packVersion: pack.packVersion,
    extensions: pack.extensions,
    basenames: pack.basenameFiles ?? [],
    basenamePrefixes: pack.basenamePrefixes ?? [],
    monaco: {
      id: pack.monacoLanguageId,
      highlighter: pack.registerHighlighter === null ? null : pack.id,
      byExtension: pack.monacoIdByExtension ?? {},
      byBasename: pack.monacoIdByBasename ?? {},
      byBasenamePrefix: pack.monacoIdByBasenamePrefix ?? {},
    },
    extractors: {
      source: pack.extractor?.kind ?? null,
      workspace: pack.workspaceExtractor === null ? null : pack.id,
    },
    fixtures: pack.fixtures?.root ?? null,
  };
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
