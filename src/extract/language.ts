export { BUILTIN_LANGUAGE_PACKS } from "../languages/builtin-packs.js";
export {
  LANGUAGE_PACKS,
  LANGUAGE_REGISTRY,
  languagePackForPath,
  monacoLanguageIdForPath,
  registerLanguagePackHighlighters,
  sourceLanguageIdForPath,
  type LanguageRegistration,
  type SourceLanguageId,
} from "../languages/registry.js";
export type {
  LanguagePack,
  LanguagePackExtractor,
  LanguagePackFixtures,
  LanguagePackId,
  MonacoHighlighterRegistrar,
} from "../languages/language-pack.js";
