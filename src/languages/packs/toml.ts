import tomlManifestJson from "../manifests/toml.language-pack.json";
import {
  EMPTY_LANGUAGE_PACK_HOOKS,
  languagePackFromManifest,
  parseLanguagePackManifest,
} from "../manifest.js";

/** Manifest highlighting for Rust workspaces; Monarch registration is owned by the Rust pack. */
export const TOML_LANGUAGE_PACK = languagePackFromManifest({
  manifest: parseLanguagePackManifest(tomlManifestJson, "builtin:toml"),
  hooks: EMPTY_LANGUAGE_PACK_HOOKS,
  source: "builtin:toml",
});
