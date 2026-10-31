import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguagePackCatalogView } from "./LanguagePacksSettings.js";
import { REPOSITORY_LANGUAGE_PACK_CATALOG } from "./language-pack-catalog.js";
import type { LanguagePackCatalogSnapshot } from "./language-pack-source.js";

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
      manifest: { extensions: [".rs"], basenames: ["Cargo.toml"], basenamePrefixes: [] },
    },
    {
      kind: "loaded",
      id: "demo",
      packVersion: "0.9.0",
      origin: "user",
      manifestPath: "/redacted/language-packs/demo/language-pack.json",
      manifest: { extensions: [".demo"], basenames: ["DemoFile"], basenamePrefixes: [] },
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
