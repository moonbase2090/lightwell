export type SourceLanguageId = "rust" | "toml" | "typescript";

export interface LanguageRegistration {
  readonly sourceLanguageId: SourceLanguageId;
  readonly monacoLanguageId: string;
  readonly extensions: readonly string[];
}

/** Canonical extension → language mapping for extractors and the source inspector. */
export const LANGUAGE_REGISTRY: readonly LanguageRegistration[] = [
  { sourceLanguageId: "rust", monacoLanguageId: "rust", extensions: [".rs"] },
  { sourceLanguageId: "toml", monacoLanguageId: "toml", extensions: [".toml"] },
  {
    sourceLanguageId: "typescript",
    monacoLanguageId: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
  },
];

function registrationForPath(filePath: string): LanguageRegistration | null {
  const lower = filePath.toLowerCase();
  let match: LanguageRegistration | null = null;
  let matchedExtensionLength = 0;
  for (const entry of LANGUAGE_REGISTRY) {
    for (const extension of entry.extensions) {
      if (!lower.endsWith(extension) || extension.length <= matchedExtensionLength) {
        continue;
      }
      match = entry;
      matchedExtensionLength = extension.length;
    }
  }
  return match;
}

export function sourceLanguageIdForPath(filePath: string): SourceLanguageId | null {
  return registrationForPath(filePath)?.sourceLanguageId ?? null;
}

/** Monaco editor language id; unknown paths keep the historical default of Rust highlighting. */
export function monacoLanguageIdForPath(filePath: string): string {
  return registrationForPath(filePath)?.monacoLanguageId ?? "rust";
}
