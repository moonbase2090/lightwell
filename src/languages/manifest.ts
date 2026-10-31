import type {
  ExternalLanguagePackId,
  LanguagePack,
  LanguagePackExtractorManifest,
  LanguagePackHookRegistry,
  LanguagePackId,
  LanguagePackManifestV1,
  LanguagePackMonacoManifest,
} from "./language-pack.js";
import { LANGUAGE_PACK_SCHEMA_VERSION } from "./language-pack.js";

const BUILTIN_IDS = new Set([
  "rust",
  "toml",
  "web",
  "python",
  "go",
  "dotnet",
  "php",
  "ruby",
  "cpp",
  "jvm",
  "config-infra",
  "swift",
]);

export const EMPTY_LANGUAGE_PACK_HOOKS: LanguagePackHookRegistry = {
  highlighters: new Map(),
  sourceExtractors: new Map(),
  workspaceExtractors: new Map(),
};

export class LanguagePackManifestError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`Invalid language pack manifest at ${source}: ${message}`);
    this.name = "LanguagePackManifestError";
    this.source = source;
  }
}

export class LanguagePackConflictError extends Error {
  readonly field: "id" | "extension" | "basename" | "basename prefix";
  readonly value: string;
  readonly firstPackId: LanguagePackId;
  readonly secondPackId: LanguagePackId;

  constructor(args: {
    readonly field: LanguagePackConflictError["field"];
    readonly value: string;
    readonly firstPackId: LanguagePackId;
    readonly secondPackId: LanguagePackId;
  }) {
    super(`Language pack ${args.field} conflict for ${JSON.stringify(args.value)} between ${args.firstPackId} and ${args.secondPackId}.`);
    this.name = "LanguagePackConflictError";
    this.field = args.field;
    this.value = args.value;
    this.firstPackId = args.firstPackId;
    this.secondPackId = args.secondPackId;
  }
}

export function parseLanguagePackManifest(
  input: unknown,
  source: string,
): LanguagePackManifestV1 {
  const root = objectValue(input, source, "manifest");
  rejectUnknownKeys(root, source, "manifest", [
    "schemaVersion",
    "id",
    "packVersion",
    "extensions",
    "basenames",
    "basenamePrefixes",
    "monaco",
    "extractors",
    "fixtures",
  ]);
  const schemaVersion = root.schemaVersion;
  if (schemaVersion !== LANGUAGE_PACK_SCHEMA_VERSION) {
    fail(source, `schemaVersion must be ${LANGUAGE_PACK_SCHEMA_VERSION}; received ${JSON.stringify(schemaVersion)}.`);
  }
  const id = languagePackId(root.id, source);
  const packVersion = packVersionValue(root.packVersion, source);
  const extensions = normalizedList(root.extensions, source, "extensions", extensionValue);
  const basenames = normalizedList(root.basenames, source, "basenames", basenameValue, true);
  const basenamePrefixes = normalizedList(root.basenamePrefixes, source, "basenamePrefixes", basenameValue, true);
  if (extensions.length === 0 && basenames.length === 0 && basenamePrefixes.length === 0) {
    fail(source, "at least one extension, basename, or basename prefix is required.");
  }
  const monaco = monacoManifest(root.monaco, source, basenames, basenamePrefixes);
  const extractors = extractorManifest(root.extractors, source);
  const fixtures = optionalString(root.fixtures, source, "fixtures");
  return {
    schemaVersion,
    id,
    packVersion,
    extensions,
    basenames,
    basenamePrefixes,
    monaco,
    extractors,
    fixtures,
  };
}

export function languagePackFromManifest(args: {
  readonly manifest: LanguagePackManifestV1;
  readonly hooks: LanguagePackHookRegistry;
  readonly source: string;
}): LanguagePack {
  const { manifest, hooks, source } = args;
  return {
    id: manifest.id,
    packVersion: manifest.packVersion,
    extensions: manifest.extensions,
    monacoLanguageId: manifest.monaco.id,
    basenameFiles: manifest.basenames,
    basenamePrefixes: manifest.basenamePrefixes,
    monacoIdByExtension: manifest.monaco.byExtension,
    monacoIdByBasename: manifest.monaco.byBasename,
    monacoIdByBasenamePrefix: manifest.monaco.byBasenamePrefix,
    extractor: resolveHook(hooks.sourceExtractors, manifest.extractors.source, source, "source extractor"),
    workspaceExtractor: resolveHook(hooks.workspaceExtractors, manifest.extractors.workspace, source, "workspace extractor"),
    registerHighlighter: resolveHook(hooks.highlighters, manifest.monaco.highlighter, source, "highlighter"),
    fixtures: manifest.fixtures === null ? null : { root: manifest.fixtures },
  };
}

export function validateLanguagePackConflicts(packs: readonly LanguagePack[]): void {
  const ids = new Map<string, LanguagePackId>();
  const extensions = new Map<string, LanguagePackId>();
  const basenames = new Map<string, LanguagePackId>();
  const prefixes: Array<{ readonly value: string; readonly packId: LanguagePackId }> = [];
  for (const pack of packs) {
    insertUnique(ids, pack.id, pack.id, "id");
    for (const extension of pack.extensions) {
      insertUnique(extensions, extension.toLowerCase(), pack.id, "extension");
    }
    for (const basename of pack.basenameFiles ?? []) {
      const lower = basename.toLowerCase();
      insertUnique(basenames, lower, pack.id, "basename");
      for (const prefix of prefixes) {
        if (lower.startsWith(prefix.value) && prefix.packId !== pack.id) {
          throw conflict("basename", basename, prefix.packId, pack.id);
        }
      }
    }
    for (const prefixValue of pack.basenamePrefixes ?? []) {
      const lower = prefixValue.toLowerCase();
      for (const existing of prefixes) {
        if ((lower.startsWith(existing.value) || existing.value.startsWith(lower)) && existing.packId !== pack.id) {
          throw conflict("basename prefix", prefixValue, existing.packId, pack.id);
        }
      }
      for (const [basename, basenamePackId] of basenames) {
        if (basename.startsWith(lower) && basenamePackId !== pack.id) {
          throw conflict("basename", basename, basenamePackId, pack.id);
        }
      }
      prefixes.push({ value: lower, packId: pack.id });
    }
  }
}

function languagePackId(value: unknown, source: string): LanguagePackId {
  const id = requiredString(value, source, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    fail(source, "id must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.");
  }
  if (BUILTIN_IDS.has(id)) return id as LanguagePackId;
  return id as ExternalLanguagePackId;
}

function monacoManifest(
  value: unknown,
  source: string,
  basenames: readonly string[],
  basenamePrefixes: readonly string[],
): LanguagePackMonacoManifest {
  const monaco = objectValue(value, source, "monaco");
  rejectUnknownKeys(monaco, source, "monaco", ["id", "highlighter", "byExtension", "byBasename", "byBasenamePrefix"]);
  const byExtension = extensionMap(monaco.byExtension, source, "monaco.byExtension");
  const byBasename = stringMap(monaco.byBasename, source, "monaco.byBasename", basenames, true);
  const byBasenamePrefix = stringMap(monaco.byBasenamePrefix, source, "monaco.byBasenamePrefix", basenamePrefixes, true);
  return {
    id: requiredString(monaco.id, source, "monaco.id"),
    highlighter: optionalString(monaco.highlighter, source, "monaco.highlighter"),
    byExtension,
    byBasename,
    byBasenamePrefix,
  };
}

function extractorManifest(value: unknown, source: string): LanguagePackExtractorManifest {
  const extractors = objectValue(value, source, "extractors");
  rejectUnknownKeys(extractors, source, "extractors", ["source", "workspace"]);
  return {
    source: optionalString(extractors.source, source, "extractors.source"),
    workspace: optionalString(extractors.workspace, source, "extractors.workspace"),
  };
}

function normalizedList(
  value: unknown,
  source: string,
  field: string,
  validate: (value: string, source: string, field: string) => string,
  caseInsensitive = false,
): readonly string[] {
  if (!Array.isArray(value)) fail(source, `${field} must be an array.`);
  const result = value.map((item, index) => validate(requiredString(item, source, `${field}[${index}]`), source, `${field}[${index}]`));
  const keys = result.map((item) => caseInsensitive ? item.toLowerCase() : item);
  if (new Set(keys).size !== keys.length) fail(source, `${field} contains duplicate values.`);
  return result;
}

function extensionValue(value: string, source: string, field: string): string {
  if (!/^\.[a-z0-9][a-z0-9.+-]*$/.test(value)) {
    fail(source, `${field} must be a lowercase extension beginning with a dot.`);
  }
  return value;
}

function basenameValue(value: string, source: string, field: string): string {
  if (value.includes("/") || value.includes("\\")) fail(source, `${field} must not contain path separators.`);
  return value;
}

function packVersionValue(value: unknown, source: string): string {
  const version = requiredString(value, source, "packVersion");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(source, "packVersion must be a semantic version such as 1.2.3.");
  }
  return version;
}

function stringMap(
  value: unknown,
  source: string,
  field: string,
  allowedKeys: readonly string[],
  caseInsensitive: boolean,
): Readonly<Record<string, string>> {
  const record = objectValue(value, source, field);
  const allowed = new Set(allowedKeys.map((key) => caseInsensitive ? key.toLowerCase() : key));
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    const lookup = caseInsensitive ? key.toLowerCase() : key;
    if (!allowed.has(lookup)) fail(source, `${field}.${key} does not match a declared path rule.`);
    result[lookup] = requiredString(item, source, `${field}.${key}`);
  }
  return result;
}

function extensionMap(
  value: unknown,
  source: string,
  field: string,
): Readonly<Record<string, string>> {
  const record = objectValue(value, source, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    const extension = extensionValue(key, source, `${field}.${key}`);
    result[extension] = requiredString(item, source, `${field}.${key}`);
  }
  return result;
}

function requiredString(value: unknown, source: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(source, `${field} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, source: string, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, source, field);
}

function objectValue(value: unknown, source: string, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(source, `${field} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  source: string,
  field: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(source, `${field} contains unknown field ${JSON.stringify(unknown[0])}.`);
}

function resolveHook<T>(
  hooks: ReadonlyMap<string, T>,
  hookName: string | null,
  source: string,
  hookKind: string,
): T | null {
  if (hookName === null) return null;
  const hook = hooks.get(hookName);
  if (hook === undefined) fail(source, `${hookKind} hook ${JSON.stringify(hookName)} is not installed.`);
  return hook;
}

function insertUnique(
  values: Map<string, LanguagePackId>,
  value: string,
  packId: LanguagePackId,
  field: LanguagePackConflictError["field"],
): void {
  const existing = values.get(value);
  if (existing !== undefined) throw conflict(field, value, existing, packId);
  values.set(value, packId);
}

function conflict(
  field: LanguagePackConflictError["field"],
  value: string,
  firstPackId: LanguagePackId,
  secondPackId: LanguagePackId,
): LanguagePackConflictError {
  return new LanguagePackConflictError({ field, value, firstPackId, secondPackId });
}

function fail(source: string, message: string): never {
  throw new LanguagePackManifestError(source, message);
}
