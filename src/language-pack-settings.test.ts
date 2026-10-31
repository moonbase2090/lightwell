import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguagePackCatalogView } from "./LanguagePacksSettings.js";
import { REPOSITORY_LANGUAGE_PACK_CATALOG } from "./language-pack-catalog.js";
import type { LanguagePackCatalogSnapshot } from "./language-pack-source.js";
import { activateLanguagePackCatalog } from "./language-pack-activation.js";
import { parseLanguagePackManifest } from "./languages/manifest.js";
import { BUILTIN_LANGUAGE_PACKS } from "./languages/builtin-packs.js";
import { monacoLanguageIdForPath, replaceLanguagePacks, sourceLanguageIdForPath } from "./languages/registry.js";

function manifest(id: string, extension: string, basename: string) {
  return parseLanguagePackManifest({
    schemaVersion: 1,
    id,
    packVersion: id === "demo" ? "0.9.0" : "1.0.0",
    extensions: [extension],
    basenames: [basename],
    basenamePrefixes: [],
    monaco: { id: id === "demo" ? "plaintext" : id, highlighter: null, byExtension: {}, byBasename: {}, byBasenamePrefix: {} },
    extractors: { source: null, workspace: null },
    fixtures: null,
  }, `test:${id}`);
}

const snapshot: LanguagePackCatalogSnapshot = {
  revision: 4,
  userPacksDirectory: "/redacted/language-packs",
  entries: [
    {
      kind: "loaded",
      id: "rust",
      packVersion: "1.0.0",
      origin: "builtin",
      manifestPath: null,
      manifest: manifest("rust", ".rs", "Cargo.toml"),
    },
    {
      kind: "loaded",
      id: "demo",
      packVersion: "0.9.0",
      origin: "user",
      manifestPath: "/redacted/language-packs/demo/language-pack.json",
      manifest: manifest("demo", ".demo", "DemoFile"),
    },
    {
      kind: "error",
      errorId: "user:broken",
      origin: "user",
      manifestPath: "/redacted/language-packs/broken/language-pack.json",
      code: "parse",
      message: "Expected a JSON object.",
    },
  ],
};

function render(dismissedErrors: ReadonlySet<string> = new Set()): string {
  return renderToStaticMarkup(createElement(LanguagePackCatalogView, {
    snapshot,
    repositoryCatalog: REPOSITORY_LANGUAGE_PACK_CATALOG,
    dismissedErrors,
    busyId: null,
    onInstall: () => undefined,
    onRemove: () => undefined,
    onDismissError: () => undefined,
  }));
}

test("language pack settings list loaded packs, extensions, status, errors, and updates", () => {
  const html = render();
  assert.match(html, /Loaded language packs/);
  assert.match(html, /<code>rust<\/code><span>v1\.0\.0<\/span>/);
  assert.match(html, /\.rs, Cargo\.toml/);
  assert.match(html, />Built in<\/span>/);
  assert.match(html, /<code>demo<\/code><span>v0\.9\.0<\/span>/);
  assert.match(html, /aria-label="Uninstall demo"/);
  assert.match(html, /Expected a JSON object\./);
  assert.match(html, /aria-label="Clear language pack error"/);
  assert.match(html, />Update<\/button>/);
});

test("clearing an invalid-pack error hides only that error", () => {
  const html = render(new Set(["user:broken"]));
  assert.equal(html.includes("Expected a JSON object."), false);
  assert.match(html, /<code>demo<\/code>/);
  assert.match(html, />Update<\/button>/);
});

test("catalog activation hot-reloads installed selectors and removes them without restart", () => {
  try {
    activateLanguagePackCatalog(snapshot);
    assert.equal(sourceLanguageIdForPath("examples/hello.demo"), "demo");
    assert.equal(monacoLanguageIdForPath("examples/hello.demo"), "plaintext");

    activateLanguagePackCatalog({ ...snapshot, revision: 5, entries: snapshot.entries.filter((entry) => entry.kind !== "loaded" || entry.id !== "demo") });
    assert.equal(sourceLanguageIdForPath("examples/hello.demo"), null);
    assert.equal(monacoLanguageIdForPath("examples/hello.demo"), "rust");
  } finally {
    replaceLanguagePacks(BUILTIN_LANGUAGE_PACKS);
  }
});
