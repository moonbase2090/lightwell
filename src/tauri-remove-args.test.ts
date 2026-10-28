import assert from "node:assert/strict";
import { test } from "node:test";
import { removeNoteArgs } from "./map-sources/tauri.js";

const input = { workspaceId: "/repo", blockId: "crate:core", expectedRevision: "rev-1", expectation: "matchesRevision" as const };

test("remove sends the loaded revision when the notes CAS flag is on", () => {
  assert.deepEqual(removeNoteArgs(input, true), {
    path: "/repo",
    blockId: "crate:core",
    expectedRevision: "rev-1",
    expectation: "matchesRevision",
  });
});

test("remove sends no revision when the notes CAS flag is off", () => {
  assert.deepEqual(removeNoteArgs(input, false), { path: "/repo", blockId: "crate:core" });
});

test("remove sends a null revision for a note that was not loaded", () => {
  assert.deepEqual(removeNoteArgs({ workspaceId: "/repo", blockId: "crate:core", expectedRevision: null, expectation: "absent" }, true), {
    path: "/repo",
    blockId: "crate:core",
    expectedRevision: null,
    expectation: "absent",
  });
});
