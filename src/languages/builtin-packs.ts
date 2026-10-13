import type { LanguagePack } from "./language-pack.js";
import { PYTHON_LANGUAGE_PACK } from "./packs/python.js";
import { RUST_LANGUAGE_PACK } from "./packs/rust.js";
import { TOML_LANGUAGE_PACK } from "./packs/toml.js";
import { TYPESCRIPT_LANGUAGE_PACK } from "./packs/typescript.js";

/**
 * Built-in language packs shipped with Lightwell. A future plugin loader merges
 * additional packs into the active registry using the same `LanguagePack` shape.
 */
export const BUILTIN_LANGUAGE_PACKS: readonly LanguagePack[] = [
  RUST_LANGUAGE_PACK,
  TOML_LANGUAGE_PACK,
  TYPESCRIPT_LANGUAGE_PACK,
  PYTHON_LANGUAGE_PACK,
];
