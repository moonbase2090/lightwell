import type * as Monaco from "monaco-editor-core";
import { BUILTIN_LANGUAGE_PACKS } from "./builtin-packs.js";
import type { LanguagePack, LanguagePackId } from "./language-pack.js";
import { validateLanguagePackConflicts } from "./manifest.js";

export type SourceLanguageId = LanguagePackId;

/** @deprecated Use `LanguagePack` via `LANGUAGE_PACKS`. */
export interface LanguageRegistration {
  readonly sourceLanguageId: SourceLanguageId;
  readonly monacoLanguageId: string;
  readonly extensions: readonly string[];
}

/** @deprecated Use `LANGUAGE_PACKS`. */
export interface LanguagePackRegistry {
  readonly packs: readonly LanguagePack[];
  readonly registrations: readonly LanguageRegistration[];
  readonly languagePackById: (id: LanguagePackId | string) => LanguagePack | undefined;
  readonly languagePackForPath: (filePath: string) => LanguagePack | null;
  readonly monacoLanguageIdForPath: (filePath: string) => string;
  readonly registerHighlighters: (monaco: typeof Monaco) => void;
}

export function createLanguagePackRegistry(packs: readonly LanguagePack[]): LanguagePackRegistry {
  validateLanguagePackConflicts(packs);
  const activePacks = [...packs];
  const registrations = activePacks.map((pack) => ({
    sourceLanguageId: pack.id,
    monacoLanguageId: pack.monacoLanguageId,
    extensions: pack.extensions,
  }));
  const packForPath = (filePath: string): LanguagePack | null => languagePackForPathIn(activePacks, filePath);
  return {
    packs: activePacks,
    registrations,
    languagePackById: (id) => activePacks.find((pack) => pack.id === id),
    languagePackForPath: packForPath,
    monacoLanguageIdForPath: (filePath) => monacoLanguageIdForPathIn(packForPath(filePath), filePath),
    registerHighlighters: (monaco) => {
      for (const pack of activePacks) pack.registerHighlighter?.(monaco);
    },
  };
}

let activeRegistry = createLanguagePackRegistry(BUILTIN_LANGUAGE_PACKS);

/** Live list used by legacy callers. Reassigned when a loader installs a registry. */
export let LANGUAGE_PACKS: readonly LanguagePack[] = activeRegistry.packs;

/** @deprecated Use `LanguagePackRegistry.registrations`. */
export let LANGUAGE_REGISTRY: readonly LanguageRegistration[] = activeRegistry.registrations;

export function replaceLanguagePacks(packs: readonly LanguagePack[]): LanguagePackRegistry {
  const registry = createLanguagePackRegistry(packs);
  activeRegistry = registry;
  LANGUAGE_PACKS = registry.packs;
  LANGUAGE_REGISTRY = registry.registrations;
  return registry;
}

export function languagePackById(id: LanguagePackId | string): LanguagePack | undefined {
  return activeRegistry.languagePackById(id);
}

function packMatchesBasename(pack: LanguagePack, basename: string): boolean {
  const lower = basename.toLowerCase();
  if (pack.basenameFiles?.some((name) => name.toLowerCase() === lower)) {
    return true;
  }
  return pack.basenamePrefixes?.some((prefix) => lower.startsWith(prefix.toLowerCase())) ?? false;
}

/** Last path segment for `/` or `\` separators. node:path is not available in the viewer bundle. */
function baseName(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
}

export function languagePackForPath(filePath: string): LanguagePack | null {
  return activeRegistry.languagePackForPath(filePath);
}

function languagePackForPathIn(packs: readonly LanguagePack[], filePath: string): LanguagePack | null {
  const lower = filePath.toLowerCase();
  const basename = baseName(filePath);
  let match: LanguagePack | null = null;
  let matchedExtensionLength = 0;
  for (const pack of packs) {
    if (packMatchesBasename(pack, basename)) {
      match = pack;
      matchedExtensionLength = Number.MAX_SAFE_INTEGER;
      continue;
    }
    for (const extension of pack.extensions) {
      if (!lower.endsWith(extension) || extension.length <= matchedExtensionLength) {
        continue;
      }
      match = pack;
      matchedExtensionLength = extension.length;
    }
  }
  return match;
}

function extensionForMonaco(filePath: string): string {
  const lower = filePath.toLowerCase();
  const basename = baseName(lower);
  if (basename === "package.json" || basename === "tsconfig.json" || basename === "jsconfig.json") {
    return ".json";
  }
  if (basename.startsWith("vite.config.") || basename.startsWith("next.config.")) {
    const dot = basename.lastIndexOf(".");
    return dot === -1 ? "" : basename.slice(dot);
  }
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
}

export function sourceLanguageIdForPath(filePath: string): SourceLanguageId | null {
  return languagePackForPath(filePath)?.id ?? null;
}

/** Monaco editor language id; paths without a registered tokenizer fall back to Rust (TOML via the Rust pack). */
export function monacoLanguageIdForPath(filePath: string): string {
  return activeRegistry.monacoLanguageIdForPath(filePath);
}

function monacoLanguageIdForPathIn(pack: LanguagePack | null, filePath: string): string {
  if (!pack) {
    return "rust";
  }
  const basename = baseName(filePath).toLowerCase();
  const exactBasenameId = pack.monacoIdByBasename?.[basename];
  if (exactBasenameId !== undefined) return exactBasenameId;
  for (const [prefix, languageId] of Object.entries(pack.monacoIdByBasenamePrefix ?? {})) {
    if (basename.startsWith(prefix.toLowerCase())) return languageId;
  }
  const extension = extensionForMonaco(filePath);
  const mapped = pack.monacoIdByExtension?.[extension];
  if (mapped !== undefined) {
    return mapped;
  }
  return pack.monacoLanguageId;
}

export function registerLanguagePackHighlighters(monaco: typeof Monaco): void {
  activeRegistry.registerHighlighters(monaco);
}
