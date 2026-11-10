import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILTIN_LANGUAGE_PACKS } from "./languages/builtin-packs.js";
import { loadLanguagePacks } from "./languages/loader.js";
import {
  EMPTY_LANGUAGE_PACK_HOOKS,
  LanguagePackManifestError,
  languagePackFromManifest,
  parseLanguagePackManifest,
} from "./languages/manifest.js";
import { createLanguagePackRegistry } from "./languages/registry.js";

const validManifest = {
  schemaVersion: 1,
  id: "example",
  packVersion: "1.2.3",
  extensions: [".example"],
  basenames: ["Examplefile"],
  basenamePrefixes: [],
  monaco: {
    id: "plaintext",
    highlighter: null,
    byExtension: {},
    byBasename: {},
    byBasenamePrefix: {},
  },
  extractors: { source: null, workspace: null },
  fixtures: null,
};

test("manifest validation rejects an extension without a leading dot", () => {
  assert.throws(
    () => parseLanguagePackManifest({ ...validManifest, extensions: ["example"] }, "broken.json"),
    (error) => error instanceof LanguagePackManifestError
      && error.message === "Invalid language pack manifest at broken.json: extensions[0] must be a lowercase extension beginning with a dot.",
  );
});

test("manifest validation requires every nullable field", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["fixtures", withoutKey(validManifest, "fixtures")],
    ["monaco.highlighter", {
      ...validManifest,
      monaco: withoutKey(validManifest.monaco, "highlighter"),
    }],
    ["extractors.source", {
      ...validManifest,
      extractors: withoutKey(validManifest.extractors, "source"),
    }],
    ["extractors.workspace", {
      ...validManifest,
      extractors: withoutKey(validManifest.extractors, "workspace"),
    }],
  ];
  for (const [field, manifest] of cases) {
    assert.throws(
      () => parseLanguagePackManifest(manifest, "missing.json"),
      (error) => error instanceof LanguagePackManifestError
        && error.message.includes(`${field} must be a non-empty string`),
      field,
    );
  }
});

test("loader treats Unicode basename case variants as a conflict", () => {
  withPackDirectory((directory) => {
    writeFileSync(
      path.join(directory, "one.language-pack.json"),
      JSON.stringify({ ...validManifest, id: "one", extensions: [], basenames: ["ÄFile"] }),
    );
    writeFileSync(
      path.join(directory, "two.language-pack.json"),
      JSON.stringify({ ...validManifest, id: "two", extensions: [], basenames: ["äfile"] }),
    );
    const loaded = loadLanguagePacks({ userPacksDirectory: directory, workspacePacksDirectory: null });
    const error = loaded.catalog.entries.find((entry) => entry.kind === "error");
    assert.equal(error?.code, "conflict");
    assert.match(error?.message ?? "", /basename conflict/);
    assert.equal(loaded.packs.some((pack) => pack.id === "two"), false);
  });
});

test("basename Monaco maps retain an own __proto__ rule", () => {
  const manifest = parseLanguagePackManifest({
    ...validManifest,
    extensions: [],
    basenames: ["__proto__", "constructor"],
    monaco: {
      ...validManifest.monaco,
      byBasename: Object.fromEntries([["__proto__", "json"]]),
    },
  }, "prototype.json");
  const pack = languagePackFromManifest({
    manifest,
    hooks: EMPTY_LANGUAGE_PACK_HOOKS,
    source: "prototype.json",
  });
  const registry = createLanguagePackRegistry([pack]);
  assert.equal(registry.monacoLanguageIdForPath("__proto__"), "json");
  assert.equal(registry.monacoLanguageIdForPath("constructor"), "plaintext");
  assert.equal(Object.hasOwn(manifest.monaco.byBasename, "__proto__"), true);
});

test("loader reports an extension conflict and keeps the built-in owner", () => {
  withPackDirectory((directory) => {
    writeFileSync(
      path.join(directory, "conflict.language-pack.json"),
      JSON.stringify({ ...validManifest, id: "rust-copy", extensions: [".rs"] }),
    );
    const loaded = loadLanguagePacks({ userPacksDirectory: directory, workspacePacksDirectory: null });
    const errors = loaded.catalog.entries.filter((entry) => entry.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "conflict");
    assert.match(errors[0]?.message ?? "", /extension conflict for "\.rs" between rust and rust-copy/);
    assert.equal(loaded.packs.some((pack) => pack.id === "rust-copy"), false);
    assert.equal(createLanguagePackRegistry(loaded.packs).languagePackForPath("src/lib.rs")?.id, "rust");
  });
});

test("loader reports an id conflict instead of letting a user pack shadow a built-in", () => {
  withPackDirectory((directory) => {
    writeFileSync(
      path.join(directory, "shadow.language-pack.json"),
      JSON.stringify({ ...validManifest, id: "rust", extensions: [".shadow"] }),
    );
    const loaded = loadLanguagePacks({ userPacksDirectory: directory, workspacePacksDirectory: null });
    const errors = loaded.catalog.entries.filter((entry) => entry.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "conflict");
    assert.match(errors[0]?.message ?? "", /id conflict for "rust" between rust and rust/);
    assert.equal(loaded.packs.filter((pack) => pack.id === "rust").length, 1);
    assert.equal(createLanguagePackRegistry(loaded.packs).languagePackForPath("src/file.shadow"), null);
  });
});

test("loader discovers a valid user pack", () => {
  withPackDirectory((directory) => {
    writeFileSync(path.join(directory, "example.language-pack.json"), JSON.stringify(validManifest));
    const loaded = loadLanguagePacks({ userPacksDirectory: directory, workspacePacksDirectory: null });
    const entry = loaded.catalog.entries.find((candidate) => candidate.kind === "loaded" && candidate.id === "example");
    assert.deepEqual(entry, {
      kind: "loaded",
      id: "example",
      packVersion: "1.2.3",
      origin: "user",
      manifestPath: path.join(directory, "example.language-pack.json"),
      manifest: parseLanguagePackManifest(validManifest, path.join(directory, "example.language-pack.json")),
    });
  });
});

test("authoring guide example validates and routes ledger paths", () => {
  const manifest = parseLanguagePackManifest(
    languagePackExampleFromGuide(),
    "docs/language-pack-authoring.md",
  );
  assert.equal(manifest.id, "ledger");
  assert.equal(manifest.packVersion, "1.0.0");
  assert.deepEqual(manifest.extensions, [".ledger", ".ldg"]);
  assert.deepEqual(manifest.basenames, ["Ledgerfile"]);
  assert.deepEqual(manifest.basenamePrefixes, ["Ledgerfile."]);
  assert.equal(manifest.fixtures, null);
  assert.deepEqual(manifest.monaco.byExtension, { ".ledger": "json" });
  assert.deepEqual(manifest.monaco.byBasename, { ledgerfile: "yaml" });
  assert.deepEqual(manifest.monaco.byBasenamePrefix, { "ledgerfile.": "dockerfile" });
  const pack = languagePackFromManifest({
    manifest,
    hooks: EMPTY_LANGUAGE_PACK_HOOKS,
    source: "docs/language-pack-authoring.md",
  });
  assert.equal(pack.extractor, null);
  assert.equal(pack.workspaceExtractor, null);
  assert.equal(pack.registerHighlighter, null);
  assert.equal(pack.fixtures, null);
  const registry = createLanguagePackRegistry([...BUILTIN_LANGUAGE_PACKS, pack]);
  assert.equal(registry.languagePackForPath("books/year.ledger")?.id, "ledger");
  assert.equal(registry.monacoLanguageIdForPath("books/year.ledger"), "json");
  assert.equal(registry.languagePackForPath("books/year.ldg")?.id, "ledger");
  assert.equal(registry.monacoLanguageIdForPath("books/year.ldg"), "plaintext");
  assert.equal(registry.languagePackForPath(String.raw`C:\books\year.ledger`)?.id, "ledger");
  assert.equal(registry.monacoLanguageIdForPath(String.raw`C:\books\year.ledger`), "json");
  assert.equal(registry.languagePackForPath("Ledgerfile")?.id, "ledger");
  assert.equal(registry.monacoLanguageIdForPath("Ledgerfile"), "yaml");
  assert.equal(registry.monacoLanguageIdForPath("LEDGERFILE"), "yaml");
  assert.equal(registry.languagePackForPath("nested/Ledgerfile.production")?.id, "ledger");
  assert.equal(registry.monacoLanguageIdForPath("nested/Ledgerfile.production"), "dockerfile");
  assert.equal(registry.monacoLanguageIdForPath("dir/Ledgerfile.ledger"), "dockerfile");
  assert.equal(registry.languagePackForPath("src/lib.rs")?.id, "rust");
  assert.equal(registry.monacoLanguageIdForPath("src/lib.rs"), "rust");
  assert.equal(registry.languagePackForPath("README.md"), null);
  assert.equal(registry.monacoLanguageIdForPath("README.md"), "rust");
});

test("sample workspace pack loads end to end and routes its source", () => {
  const repositoryPath = path.join(
    process.cwd(),
    "crates",
    "lightwell-core",
    "fixtures",
    "language-pack-sample",
  );
  const loaded = loadLanguagePacks({ repositoryPath, userPacksDirectory: null });
  const registry = createLanguagePackRegistry(loaded.packs);
  assert.equal(registry.languagePackForPath("src/example.demo")?.id, "demo");
  assert.equal(registry.languagePackForPath("nested/DemoFile")?.id, "demo");
  assert.equal(registry.monacoLanguageIdForPath("src/example.demo"), "plaintext");
  assert.equal(loaded.catalog.entries.find((entry) => entry.kind === "loaded" && entry.id === "demo")?.origin, "workspace");
});

function languagePackExampleFromGuide(): unknown {
  const guide = readFileSync(path.join(process.cwd(), "docs", "language-pack-authoring.md"), "utf8");
  const marker = "```json language-pack-example";
  const start = guide.indexOf(marker);
  assert.ok(start >= 0, "docs/language-pack-authoring.md is missing the language-pack-example fence");
  assert.equal(
    guide.indexOf(marker, start + marker.length),
    -1,
    "docs/language-pack-authoring.md has more than one language-pack-example fence",
  );
  const jsonStart = guide.indexOf("\n", start);
  assert.ok(jsonStart > start);
  const jsonEnd = guide.indexOf("\n```", jsonStart);
  assert.ok(jsonEnd > jsonStart, "the language-pack-example fence is not closed");
  return JSON.parse(guide.slice(jsonStart + 1, jsonEnd));
}

function withPackDirectory(run: (directory: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "lightwell-language-packs-"));
  const directory = path.join(root, "packs");
  mkdirSync(directory);
  try {
    run(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withoutKey(value: object, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}
