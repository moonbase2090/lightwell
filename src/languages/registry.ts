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

export function languagePackForPath(filePath: string): LanguagePack | null {
  const lower = filePath.toLowerCase();
  let match: LanguagePack | null = null;
  let matchedExtensionLength = 0;
  for (const pack of LANGUAGE_PACKS) {
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

export function sourceLanguageIdForPath(filePath: string): SourceLanguageId | null {
  return languagePackForPath(filePath)?.id ?? null;
}

/** Monaco editor language id; unknown paths keep the historical default of Rust highlighting. */
export function monacoLanguageIdForPath(filePath: string): string {
  return languagePackForPath(filePath)?.monacoLanguageId ?? "rust";
}

export function registerLanguagePackHighlighters(monaco: typeof Monaco): void {
  for (const pack of LANGUAGE_PACKS) {
    pack.registerHighlighter?.(monaco);
  }
}
