import type * as Monaco from "monaco-editor-core";
import { BUILTIN_LANGUAGE_PACKS } from "./builtin-packs.js";
import type { LanguagePack, LanguagePackId } from "./language-pack.js";

/** Active packs (built-ins today; plugin loader will append here later). */
export const LANGUAGE_PACKS: readonly LanguagePack[] = BUILTIN_LANGUAGE_PACKS;

export type SourceLanguageId = LanguagePackId;

/** @deprecated Use `LanguagePack` via `LANGUAGE_PACKS`. */
export interface LanguageRegistration {
  readonly sourceLanguageId: SourceLanguageId;
  readonly monacoLanguageId: string;
  readonly extensions: readonly string[];
}

/** @deprecated Use `LANGUAGE_PACKS`. */
export const LANGUAGE_REGISTRY: readonly LanguageRegistration[] = LANGUAGE_PACKS.map((pack) => ({
  sourceLanguageId: pack.id,
  monacoLanguageId: pack.monacoLanguageId,
  extensions: pack.extensions,
}));

export function languagePackById(id: LanguagePackId): LanguagePack | undefined {
  return LANGUAGE_PACKS.find((pack) => pack.id === id);
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
  const lower = filePath.toLowerCase();
  const basename = baseName(filePath);
  let match: LanguagePack | null = null;
  let matchedExtensionLength = 0;
  for (const pack of LANGUAGE_PACKS) {
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
  const pack = languagePackForPath(filePath);
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
  if (pack.registerHighlighter !== null) {
    return pack.monacoLanguageId;
  }
  if (pack.id === "toml") {
    return "toml";
  }
  return "rust";
}

export function registerLanguagePackHighlighters(monaco: typeof Monaco): void {
  for (const pack of LANGUAGE_PACKS) {
    pack.registerHighlighter?.(monaco);
  }
}
