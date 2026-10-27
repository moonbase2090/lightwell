import type { LanguagePack } from "./language-pack.js";
import { CPP_LANGUAGE_PACK } from "./packs/cpp.js";
import { DOTNET_LANGUAGE_PACK } from "./packs/dotnet.js";
import { CONFIG_INFRA_LANGUAGE_PACK } from "./packs/config-infra.js";
import { GO_LANGUAGE_PACK } from "./packs/go.js";
import { PHP_LANGUAGE_PACK } from "./packs/php.js";
import { JVM_LANGUAGE_PACK } from "./packs/jvm.js";
import { PYTHON_LANGUAGE_PACK } from "./packs/python.js";
import { RUBY_LANGUAGE_PACK } from "./packs/ruby.js";
import { RUST_LANGUAGE_PACK } from "./packs/rust.js";
import { TOML_LANGUAGE_PACK } from "./packs/toml.js";
import { WEB_LANGUAGE_PACK } from "./packs/web.js";

/**
 * Built-in language packs shipped with Lightwell. A future plugin loader merges
 * additional packs into the active registry using the same `LanguagePack` shape.
 */
export const BUILTIN_LANGUAGE_PACKS: readonly LanguagePack[] = [
  RUST_LANGUAGE_PACK,
  TOML_LANGUAGE_PACK,
  WEB_LANGUAGE_PACK,
  PYTHON_LANGUAGE_PACK,
  GO_LANGUAGE_PACK,
  DOTNET_LANGUAGE_PACK,
  PHP_LANGUAGE_PACK,
  RUBY_LANGUAGE_PACK,
  JVM_LANGUAGE_PACK,
  CPP_LANGUAGE_PACK,
  CONFIG_INFRA_LANGUAGE_PACK,
];
