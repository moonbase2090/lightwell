import assert from "node:assert/strict";
import {
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
} from "../src/map-sources/tauri-types.js";

const entry = { id: "/projects/lightwell", label: "Lightwell" };
assert.deepEqual(parseMapSourceEntry(entry), entry);
assert.deepEqual(parseMapSourceEntries([entry]), [entry]);
assert.deepEqual(parseMapSourceDocument({ facts: { schemaVersion: 1 }, annotations: {} }), {
  facts: { schemaVersion: 1 },
  annotations: {},
});
assert.throws(() => parseMapSourceEntry({ id: entry.id, label: 3 }), /invalid workspace entry/);
assert.throws(() => parseMapSourceEntries({}), /invalid recent workspaces list/);
assert.throws(() => parseMapSourceDocument({ facts: {} }), /invalid workspace map/);

console.log("Tauri map source IPC responses passed boundary checks.");
