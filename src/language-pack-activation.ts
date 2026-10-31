import { BUILTIN_LANGUAGE_PACKS } from "./languages/builtin-packs.js";
import type { LanguagePackHookRegistry } from "./languages/language-pack.js";
import { languagePackFromManifest } from "./languages/manifest.js";
import { replaceLanguagePacks } from "./languages/registry.js";
import type { LanguagePackCatalogSnapshot, LoadedLanguagePackEntry } from "./language-pack-source.js";

const BUILTIN_LANGUAGE_PACK_HOOKS: LanguagePackHookRegistry = {
  highlighters: new Map(BUILTIN_LANGUAGE_PACKS.flatMap((pack) => (
    pack.registerHighlighter === null ? [] : [[pack.id, pack.registerHighlighter] as const]
  ))),
  sourceExtractors: new Map(BUILTIN_LANGUAGE_PACKS.flatMap((pack) => (
    pack.extractor === null ? [] : [[pack.extractor.kind, pack.extractor] as const]
  ))),
  workspaceExtractors: new Map(BUILTIN_LANGUAGE_PACKS.flatMap((pack) => (
    pack.workspaceExtractor === null ? [] : [[pack.id, pack.workspaceExtractor] as const]
  ))),
};

export function activateLanguagePackCatalog(catalog: LanguagePackCatalogSnapshot): void {
  const installed = catalog.entries
    .filter((entry): entry is LoadedLanguagePackEntry => entry.kind === "loaded" && entry.origin !== "builtin")
    .map((entry) => languagePackFromManifest({
      manifest: entry.manifest,
      hooks: BUILTIN_LANGUAGE_PACK_HOOKS,
      source: entry.manifestPath ?? `${entry.origin}:${entry.id}`,
    }));
  replaceLanguagePacks([...BUILTIN_LANGUAGE_PACKS, ...installed]);
}
