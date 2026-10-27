import assert from "node:assert/strict";
import test from "node:test";
import {
  isMapPopoutSearch,
  mapPopoutShortcut,
  parseMapPopoutSync,
  workspaceFromPopoutSearch,
} from "./map-popout.js";

const sync = {
  workspaceId: "/work/demo",
  selectedId: "crate:demo",
  scopePath: ["workspace:demo", "crate:demo"],
  mapView: "files" as const,
  orientation: "horizontal" as const,
  fileScope: "crates/demo/src",
  notesRevision: 2,
  revision: 4,
};

test("parseMapPopoutSync accepts a complete sync payload", () => {
  assert.deepEqual(parseMapPopoutSync({ ...sync, extra: true }), sync);
  assert.deepEqual(parseMapPopoutSync({ ...sync, revision: 0, notesRevision: 0, selectedId: "", scopePath: [], fileScope: "" }), {
    ...sync,
    revision: 0,
    notesRevision: 0,
    selectedId: "",
    scopePath: [],
    fileScope: "",
  });
});

test("parseMapPopoutSync rejects malformed payloads", () => {
  assert.throws(() => parseMapPopoutSync(null), /must be an object/);
  assert.throws(() => parseMapPopoutSync([]), /must be an object/);
  assert.throws(() => parseMapPopoutSync({ ...sync, workspaceId: "" }), /workspaceId/);
  assert.throws(() => parseMapPopoutSync({ ...sync, selectedId: 4 }), /selectedId/);
  assert.throws(() => parseMapPopoutSync({ ...sync, scopePath: ["ok", 1] }), /scopePath/);
  assert.throws(() => parseMapPopoutSync({ ...sync, mapView: "Modules" }), /mapView/);
  assert.throws(() => parseMapPopoutSync({ ...sync, orientation: "grid" }), /orientation/);
  assert.throws(() => parseMapPopoutSync({ ...sync, fileScope: null }), /fileScope/);
  assert.throws(() => parseMapPopoutSync({ ...sync, notesRevision: 1.5 }), /notesRevision/);
  assert.throws(() => parseMapPopoutSync({ ...sync, notesRevision: -1 }), /notesRevision/);
  assert.throws(() => parseMapPopoutSync({ ...sync, revision: "4" }), /revision/);
  const parsed = parseMapPopoutSync(sync);
  assert.notEqual(parsed.scopePath, sync.scopePath);
});

test("map pop-out search reads map-popout=1 and the workspace id", () => {
  assert.equal(isMapPopoutSearch("?map-popout=1"), true);
  assert.equal(isMapPopoutSearch("map-popout=1&workspace=alpha"), true);
  assert.equal(isMapPopoutSearch("?map-popout=true"), false);
  assert.equal(isMapPopoutSearch("?Map-Popout=1"), false);
  assert.equal(isMapPopoutSearch(""), false);
  assert.equal(isMapPopoutSearch("?workspace=%2Fwork%2Fdemo"), false);
  assert.equal(workspaceFromPopoutSearch("?map-popout=1&workspace=%2Fwork%2Fdemo"), "/work/demo");
  assert.equal(workspaceFromPopoutSearch("workspace=alpha"), "alpha");
  assert.equal(workspaceFromPopoutSearch("?map-popout=1"), null);
  assert.equal(workspaceFromPopoutSearch("?workspace="), null);
  assert.equal(workspaceFromPopoutSearch(""), null);
});

test("map pop-out shortcut is Ctrl or Cmd with Shift and M", () => {
  assert.equal(mapPopoutShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, key: "M" }), true);
  assert.equal(mapPopoutShortcut({ metaKey: false, ctrlKey: true, shiftKey: true, key: "m" }), true);
  assert.equal(mapPopoutShortcut({ metaKey: true, ctrlKey: true, shiftKey: true, key: "M" }), true);
  assert.equal(mapPopoutShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, key: "m" }), false);
  assert.equal(mapPopoutShortcut({ metaKey: false, ctrlKey: false, shiftKey: true, key: "m" }), false);
  assert.equal(mapPopoutShortcut({ metaKey: false, ctrlKey: true, shiftKey: true, key: "k" }), false);
  assert.equal(mapPopoutShortcut({ metaKey: false, ctrlKey: false, shiftKey: false, key: "m" }), false);
});
