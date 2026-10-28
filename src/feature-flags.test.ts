import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { commitDiffEnabled, mapPopoutEnabled, notesCasEnabled, notesStaleActionsEnabled, projectNotesEnabled } from "./feature-flags.js";

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

test("notes stale actions stay off unless VITE_ENABLE_NOTES_STALE_ACTIONS=true", () => {
  assert.equal(notesStaleActionsEnabled(undefined), false);
  assert.equal(notesStaleActionsEnabled(""), false);
  assert.equal(notesStaleActionsEnabled("false"), false);
  assert.equal(notesStaleActionsEnabled("TRUE"), false);
  assert.equal(notesStaleActionsEnabled("true"), true);
});

test("stale-action call sites compare the env string so the bundler can drop the branch", () => {
  const fixtures = readFileSync(new URL("./map-sources/fixtures.ts", import.meta.url), "utf8");
  const tauri = readFileSync(new URL("./map-sources/tauri.ts", import.meta.url), "utf8");
  for (const source of [fixtures, tauri]) {
    assert.match(source, /import\.meta\.env\.VITE_ENABLE_NOTES_STALE_ACTIONS\) === "true"/);
    assert.equal(source.includes("notesStaleActionsEnabled"), false);
  }
});

test("commit diff is on when the build sets no flag", () => {
  assert.equal(commitDiffEnabled(undefined), true);
  assert.equal(commitDiffEnabled(""), true);
  assert.equal(commitDiffEnabled("true"), true);
});

test("commit diff can be turned off with VITE_ENABLE_COMMIT_DIFF=false", () => {
  assert.equal(commitDiffEnabled("false"), false);
  assert.equal(commitDiffEnabled(" FALSE "), true);
});

test("history call sites compare the env string so the bundler can drop the branch", () => {
  const tauri = readFileSync(new URL("./map-sources/tauri.ts", import.meta.url), "utf8");
  assert.match(tauri, /import\.meta\.env\.VITE_ENABLE_COMMIT_DIFF\) === "false"/);
  assert.equal(tauri.includes("commitDiffEnabled"), false);
});

test("notes compare-and-swap is off unless the build sets VITE_ENABLE_NOTES_CAS=true", () => {
  assert.equal(notesCasEnabled(undefined), false);
  assert.equal(notesCasEnabled(""), false);
  assert.equal(notesCasEnabled("false"), false);
  assert.equal(notesCasEnabled("TRUE"), false);
  assert.equal(notesCasEnabled(" true "), false);
  assert.equal(notesCasEnabled("true"), true);
});

test("notes compare-and-swap call sites compare the env string so the bundler can drop the branch", () => {
  const files = [
    "./ProjectNotesDialog.tsx",
    "./App.tsx",
    "./map-sources/tauri.ts",
    "./map-sources/fixtures.ts",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /import\.meta\.env\.VITE_ENABLE_NOTES_CAS === "true"/);
    assert.equal(source.includes("notesCasEnabled"), false);
  }
});
