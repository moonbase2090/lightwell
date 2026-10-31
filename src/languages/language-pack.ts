import type * as Monaco from "monaco-editor-core";
import type { FactMap } from "../model.js";

export const LANGUAGE_PACK_SCHEMA_VERSION = 1;

export type BuiltinLanguagePackId = "rust" | "toml" | "web" | "python" | "go" | "dotnet" | "php" | "ruby" | "cpp" | "jvm" | "config-infra" | "swift";
declare const externalLanguagePackIdBrand: unique symbol;
export type ExternalLanguagePackId = string & { readonly [externalLanguagePackIdBrand]: "ExternalLanguagePackId" };
export type LanguagePackId = BuiltinLanguagePackId | ExternalLanguagePackId;

export interface WorkspaceExtractArgs {
  readonly repositoryPath: string;
  readonly projectName?: string;
}

export type WorkspaceExtractor = (args: WorkspaceExtractArgs) => FactMap;

/** How map extraction is implemented for a pack (plugin loader will register the same shape). */
export type LanguagePackExtractor =
  | {
      readonly kind: "rust-workspace";
      readonly cargoMapModule: "extract/cargo";
      readonly moduleTreeModule: "extract/rust-modules";
      readonly coreSourceModule: "lightwell_core::rust_source";
    }
  | {
      readonly kind: "web-module";
      readonly moduleId: "extract/web-modules";
      readonly coreSourceModule: "lightwell_core::typescript_source";
    }
  | {
      readonly kind: "python-module";
      readonly moduleId: "extract/python-modules";
      readonly coreSourceModule: "lightwell_core::python_source";
    }
  | {
      readonly kind: "go-module";
      readonly moduleId: "extract/go-modules";
      readonly coreSourceModule: "lightwell_core::go_source";
    }
  | {
      readonly kind: "dotnet-module";
      readonly moduleId: "extract/dotnet-modules";
      readonly coreSourceModule: "lightwell_core::dotnet_source";
    }
  | {
      readonly kind: "php-module";
      readonly moduleId: "extract/php-modules";
      readonly coreSourceModule: "lightwell_core::php_source";
    }
  | {
      readonly kind: "ruby-module";
      readonly moduleId: "extract/ruby-modules";
      readonly coreSourceModule: "lightwell_core::ruby_source";
    }
  | {
      readonly kind: "cpp-module";
      readonly moduleId: "extract/cpp-modules";
      readonly coreSourceModule: "lightwell_core::cpp_source";
    }
  | {
      readonly kind: "jvm-module";
      readonly moduleId: "extract/jvm-modules";
      readonly coreSourceModule: "lightwell_core::jvm_source";
    }
  | {
      readonly kind: "config-infra-module";
      readonly moduleId: "extract/config-infra";
      readonly coreSourceModule: "lightwell_core::config_infra_source";
    }
  | {
      readonly kind: "swift-module";
      readonly moduleId: "extract/swift-modules";
      readonly coreSourceModule: "lightwell_core::swift_source";
    };

export interface LanguagePackFixtures {
  /** Repository-relative directory holding golden inputs for this pack. */
  readonly root: string;
}

export type MonacoHighlighterRegistrar = (monaco: typeof Monaco) => void;

export interface LanguagePackMonacoManifest {
  readonly id: string;
  readonly highlighter: string | null;
  readonly byExtension: Readonly<Record<string, string>>;
  readonly byBasename: Readonly<Record<string, string>>;
  readonly byBasenamePrefix: Readonly<Record<string, string>>;
}

export interface LanguagePackExtractorManifest {
  readonly source: string | null;
  readonly workspace: string | null;
}

/** Version 1 JSON manifest. Hook names resolve through a host-provided table. */
export interface LanguagePackManifestV1 {
  readonly schemaVersion: typeof LANGUAGE_PACK_SCHEMA_VERSION;
  readonly id: LanguagePackId;
  readonly packVersion: string;
  readonly extensions: readonly string[];
  readonly basenames: readonly string[];
  readonly basenamePrefixes: readonly string[];
  readonly monaco: LanguagePackMonacoManifest;
  readonly extractors: LanguagePackExtractorManifest;
  readonly fixtures: string | null;
}

export interface LanguagePackHookRegistry {
  readonly highlighters: ReadonlyMap<string, MonacoHighlighterRegistrar>;
  readonly sourceExtractors: ReadonlyMap<string, LanguagePackExtractor>;
  readonly workspaceExtractors: ReadonlyMap<string, WorkspaceExtractor>;
}

/**
 * One installable language surface: file extensions, extraction, inspector highlighting, and tests.
 * Built-in packs ship in `builtin-packs.ts`; a future loader appends plugin packs to the same list.
 */
export interface LanguagePack {
  readonly id: LanguagePackId;
  readonly packVersion: string;
  readonly extensions: readonly string[];
  /** Default Monaco id when `monacoIdForPath` has no extension match. */
  readonly monacoLanguageId: string;
  /** Exact basenames (e.g. `package.json`) that belong to this pack. */
  readonly basenameFiles?: readonly string[];
  /** Config stems such as `vite.config.` matching `vite.config.ts`. */
  readonly basenamePrefixes?: readonly string[];
  /** Monaco language ids for exact basenames, such as Dockerfile. */
  readonly monacoIdByBasename?: Readonly<Record<string, string>>;
  /** Monaco language ids for basename prefixes, such as Dockerfile.dev. */
  readonly monacoIdByBasenamePrefix?: Readonly<Record<string, string>>;
  /** Monaco language id per file extension (includes the leading dot). */
  readonly monacoIdByExtension?: Readonly<Record<string, string>>;
  /** Describes source parsing modules; null until a pack extracts map facts. */
  readonly extractor: LanguagePackExtractor | null;
  /**
   * Whole-workspace extraction (Cargo maps today). Null for highlight-only packs such as TOML.
   * Plugin packs register the same callback shape as built-ins.
   */
  readonly workspaceExtractor: WorkspaceExtractor | null;
  /** Monarch or other Monaco registration; null when Monaco ships a default tokenizer. */
  readonly registerHighlighter: MonacoHighlighterRegistrar | null;
  /** Null until pack-specific fixtures exist under the repo. */
  readonly fixtures: LanguagePackFixtures | null;
}
