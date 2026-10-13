import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectNotesEnabled } from "./feature-flags.js";

test("project notes are on when the build sets no flag", () => {
  assert.equal(projectNotesEnabled(undefined), true);
  assert.equal(projectNotesEnabled(""), true);
  assert.equal(projectNotesEnabled("true"), true);
});

test("project notes can be turned off with VITE_ENABLE_PROJECT_NOTES=false", () => {
  assert.equal(projectNotesEnabled("false"), false);
  assert.equal(projectNotesEnabled(" FALSE "), true);
  assert.equal(projectNotesEnabled("False"), true);
});

test("notes call sites compare the env string so the bundler can drop the branch", () => {
  const fixtures = readFileSync(new URL("./map-sources/fixtures.ts", import.meta.url), "utf8");
  const tauri = readFileSync(new URL("./map-sources/tauri.ts", import.meta.url), "utf8");
  for (const source of [fixtures, tauri]) {
    assert.match(source, /import\.meta\.env\.VITE_ENABLE_PROJECT_NOTES\) === "false"/);
    assert.equal(source.includes("projectNotesEnabled"), false);
  }
});
