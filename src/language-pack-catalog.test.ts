import assert from "node:assert/strict";
import test from "node:test";
import {
  REPOSITORY_LANGUAGE_PACK_CATALOG,
  catalogPackAction,
  catalogPackStatus,
  comparePackVersions,
  parseRepositoryLanguagePackCatalog,
} from "./language-pack-catalog.js";

const demoPack = REPOSITORY_LANGUAGE_PACK_CATALOG.packs[0];
if (demoPack === undefined) throw new Error("The test catalog needs a demo pack.");

test("repository catalog parses its installable demo pack", () => {
  assert.equal(REPOSITORY_LANGUAGE_PACK_CATALOG.schemaVersion, 1);
  assert.deepEqual(demoPack, {
    id: "demo",
    packVersion: "1.0.0",
    description: "Plain-text support for .demo files and DemoFile.",
    extensions: [".demo"],
  });
});

test("catalog parser rejects duplicate ids", () => {
  assert.throws(() => parseRepositoryLanguagePackCatalog({
    schemaVersion: 1,
    revision: 1,
    packs: [demoPack, demoPack],
  }), /duplicate ids/);
});

test("catalog parser rejects invalid pack ids", () => {
  assert.throws(() => parseRepositoryLanguagePackCatalog({
    schemaVersion: 1,
    revision: 1,
    packs: [{ ...demoPack, id: "../secret" }],
  }), /invalid pack/);
});

test("install flow installs a missing pack without replacing files", () => {
  assert.deepEqual(catalogPackStatus(demoPack, []), { kind: "available" });
  assert.deepEqual(catalogPackAction(demoPack, []), {
    kind: "install",
    source: { kind: "catalog", id: "demo" },
    replace: false,
  });
});

test("install flow updates an older user pack with replacement enabled", () => {
  const installed = [{ id: "demo", packVersion: "0.9.2", origin: "user" }] as const;
  assert.equal(catalogPackStatus(demoPack, installed).kind, "update");
  assert.deepEqual(catalogPackAction(demoPack, installed), {
    kind: "update",
    source: { kind: "catalog", id: "demo" },
    replace: true,
  });
});

test("install flow does not overwrite built-in or workspace packs", () => {
  assert.deepEqual(catalogPackAction(demoPack, [{ id: "demo", packVersion: "0.1.0", origin: "builtin" }]), { kind: "none" });
  assert.deepEqual(catalogPackAction(demoPack, [{ id: "demo", packVersion: "0.1.0", origin: "workspace" }]), { kind: "none" });
});

test("version comparison uses numeric semantic-version components", () => {
  assert.equal(comparePackVersions("1.10.0", "1.9.9"), 1);
  assert.equal(comparePackVersions("2.0.0", "2.0.0"), 0);
  assert.equal(comparePackVersions("0.8.4", "0.9.0"), -1);
  assert.throws(() => comparePackVersions("v1", "1.0.0"), /Invalid language pack version/);
});
