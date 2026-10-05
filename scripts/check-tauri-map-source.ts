import assert from "node:assert/strict";
import {
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
  parseProjectNotesSnapshot,
  parseWorkspaceMapUpdate,
} from "../src/map-sources/tauri-types.js";

const entry = { id: "/projects/lightwell", label: "Lightwell" };
const note = {
  blockId: "module:lightwell:workspace",
  text: "Keep the local extraction boundary clear.",
  sourceFingerprint: "fingerprint-1",
  stale: false,
};
const projectNotes = { kind: "ready", notes: [note] };
assert.deepEqual(parseMapSourceEntry(entry), entry);
assert.deepEqual(parseMapSourceEntries([entry]), [entry]);
assert.deepEqual(parseMapSourceDocument({ facts: { schemaVersion: 1 }, annotations: {} }), {
  facts: { schemaVersion: 1 },
  annotations: {},
});
assert.deepEqual(parseWorkspaceMapUpdate({
  workspaceId: entry.id,
  document: { facts: { schemaVersion: 1 }, annotations: {}, projectNotes },
}), {
  workspaceId: entry.id,
  document: { facts: { schemaVersion: 1 }, annotations: {}, projectNotes },
});
assert.deepEqual(parseProjectNotesSnapshot(projectNotes), projectNotes);
assert.deepEqual(parseProjectNotesSnapshot({ kind: "error", message: "Could not read notes." }), {
  kind: "error",
  message: "Could not read notes.",
});
assert.throws(() => parseMapSourceEntry({ id: entry.id, label: 3 }), /invalid workspace entry/);
assert.throws(() => parseMapSourceEntries({}), /invalid recent workspaces list/);
assert.throws(() => parseMapSourceDocument({ facts: {} }), /invalid workspace map/);
assert.throws(() => parseWorkspaceMapUpdate({ workspaceId: entry.id, document: {} }), /invalid workspace map/);
assert.throws(() => parseProjectNotesSnapshot({ kind: "ready", notes: [{ ...note, stale: "false" }] }), /invalid project note/);
assert.throws(() => parseProjectNotesSnapshot({ kind: "unknown", notes: [] }), /invalid project notes response/);

console.log("Tauri map and project notes IPC responses passed boundary checks.");
