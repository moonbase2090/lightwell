import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLanguagePacks } from "./languages/loader.js";
import { LanguagePackManifestError, parseLanguagePackManifest } from "./languages/manifest.js";
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
