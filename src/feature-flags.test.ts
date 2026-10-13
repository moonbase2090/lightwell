import assert from "node:assert/strict";
import test from "node:test";
import { projectNotesEnabled } from "./feature-flags.js";

test("project notes are on when the build sets no flag", () => {
  assert.equal(projectNotesEnabled(undefined), true);
  assert.equal(projectNotesEnabled(""), true);
  assert.equal(projectNotesEnabled("true"), true);
});

test("project notes can be turned off with VITE_ENABLE_PROJECT_NOTES=false", () => {
  assert.equal(projectNotesEnabled("false"), false);
  assert.equal(projectNotesEnabled(" FALSE "), false);
});
