import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { commitDiffEnabled, compoundLayoutEnabled, mapPopoutEnabled, notesCasEnabled, notesStaleActionsEnabled, projectNotesEnabled, stateChartEnabled } from "./feature-flags.js";

test("compound layout is on when the build sets no flag", () => {
  assert.equal(compoundLayoutEnabled(undefined), true);
  assert.equal(compoundLayoutEnabled(""), true);
  assert.equal(compoundLayoutEnabled("true"), true);
});

test("compound layout can be turned off with VITE_ENABLE_COMPOUND_LAYOUT=false", () => {
  assert.equal(compoundLayoutEnabled("false"), false);
  assert.equal(compoundLayoutEnabled(" FALSE "), true);
  assert.equal(compoundLayoutEnabled("False"), true);
});

test("the app starts the compound layout worker only behind a flag other than the exact false", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /import\.meta\.env\.VITE_ENABLE_COMPOUND_LAYOUT !== "false"/);
  assert.match(app, /createCompoundLayoutFeature\("true"\)/);
});

test("state charts are on when the build sets no flag", () => {
  assert.equal(stateChartEnabled(undefined), true);
  assert.equal(stateChartEnabled(""), true);
  assert.equal(stateChartEnabled("true"), true);
});

test("state charts can be turned off with VITE_ENABLE_STATE_CHART=false", () => {
  assert.equal(stateChartEnabled("false"), false);
  assert.equal(stateChartEnabled(" FALSE "), true);
  assert.equal(stateChartEnabled("False"), true);
});

test("the app loads state charts statically and hides them only for the exact false flag", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /import StateChartFeature from "\.\/StateChartFeature\.js"/);
  assert.match(app, /import\.meta\.env\.VITE_ENABLE_STATE_CHART !== "false" &&/);
  assert.equal(app.includes('VITE_ENABLE_STATE_CHART === "true"'), false);
  assert.equal(app.includes("import(\"./StateChartFeature.js\")"), false);
  assert.equal(app.includes("stateChartEnabled"), false);
});

test("state charts add no runtime package or module loader", () => {
  const feature = readFileSync(new URL("./StateChartFeature.tsx", import.meta.url), "utf8");
  const detector = readFileSync(new URL("./state-chart.ts", import.meta.url), "utf8");
  assert.equal(feature.includes("import("), false);
  assert.equal(detector.includes(" from \""), false);
});

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

test("map pop-out is on when the build sets no flag", () => {
  assert.equal(mapPopoutEnabled(undefined), true);
  assert.equal(mapPopoutEnabled(""), true);
  assert.equal(mapPopoutEnabled("true"), true);
});

test("map pop-out can be turned off with VITE_ENABLE_MAP_POPOUT=false", () => {
  assert.equal(mapPopoutEnabled("false"), false);
  assert.equal(mapPopoutEnabled("False"), true);
});

test("notes stale actions are on when the build sets no flag", () => {
  assert.equal(notesStaleActionsEnabled(undefined), true);
  assert.equal(notesStaleActionsEnabled(""), true);
  assert.equal(notesStaleActionsEnabled("true"), true);
});

test("notes stale actions can be turned off with VITE_ENABLE_NOTES_STALE_ACTIONS=false", () => {
  assert.equal(notesStaleActionsEnabled("false"), false);
  assert.equal(notesStaleActionsEnabled("FALSE"), true);
});

test("stale-action call sites compare the env string so the bundler can drop the branch", () => {
  const fixtures = readFileSync(new URL("./map-sources/fixtures.ts", import.meta.url), "utf8");
  const tauri = readFileSync(new URL("./map-sources/tauri.ts", import.meta.url), "utf8");
  for (const source of [fixtures, tauri]) {
    assert.match(source, /import\.meta\.env\.VITE_ENABLE_NOTES_STALE_ACTIONS\) !== "false"/);
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

test("notes compare-and-swap is on when the build sets no flag", () => {
  assert.equal(notesCasEnabled(undefined), true);
  assert.equal(notesCasEnabled(""), true);
  assert.equal(notesCasEnabled("true"), true);
});

test("notes compare-and-swap can be turned off with VITE_ENABLE_NOTES_CAS=false", () => {
  assert.equal(notesCasEnabled("false"), false);
  assert.equal(notesCasEnabled(" false "), true);
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
    assert.match(source, /import\.meta\.env\.VITE_ENABLE_NOTES_CAS !== "false"/);
    assert.equal(source.includes("notesCasEnabled"), false);
  }
});
