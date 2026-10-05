import assert from "node:assert/strict";
import {
  parseEditorSettings,
  parseEditorTemplatePresets,
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
  parseSourceFileDocument,
  parseWorkspaceMapUpdate,
} from "../src/map-sources/tauri-types.js";

const entry = { id: "/projects/lightwell", label: "Lightwell" };
assert.deepEqual(parseMapSourceEntry(entry), entry);
assert.deepEqual(parseMapSourceEntries([entry]), [entry]);
assert.deepEqual(parseMapSourceDocument({ facts: { schemaVersion: 1 }, annotations: {} }), {
  facts: { schemaVersion: 1 },
  annotations: {},
});
assert.deepEqual(parseWorkspaceMapUpdate({
  workspaceId: entry.id,
  document: { facts: { schemaVersion: 1 }, annotations: {} },
}), {
  workspaceId: entry.id,
  document: { facts: { schemaVersion: 1 }, annotations: {} },
});
assert.throws(() => parseMapSourceEntry({ id: entry.id, label: 3 }), /invalid workspace entry/);
assert.throws(() => parseMapSourceEntries({}), /invalid recent workspaces list/);
assert.throws(() => parseMapSourceDocument({ facts: {} }), /invalid workspace map/);
assert.throws(() => parseWorkspaceMapUpdate({ workspaceId: entry.id, document: {} }), /invalid workspace map/);
assert.deepEqual(parseSourceFileDocument({ path: "src/lib.rs", content: "pub mod map;", line: 1, column: 9 }), {
  path: "src/lib.rs",
  content: "pub mod map;",
  line: 1,
  column: 9,
});
assert.deepEqual(parseEditorSettings({ commandTemplate: null }), { commandTemplate: null });
assert.deepEqual(parseEditorSettings({ commandTemplate: "zed {file}:{line}:{column}" }), {
  commandTemplate: "zed {file}:{line}:{column}",
});
assert.deepEqual(parseEditorTemplatePresets([{ name: "Zed", template: "zed {file}" }]), [
  { name: "Zed", template: "zed {file}" },
]);
assert.throws(() => parseSourceFileDocument({ path: "src/lib.rs", content: "", line: 0, column: 1 }), /invalid source file/);
assert.throws(() => parseEditorSettings({ commandTemplate: 3 }), /invalid editor settings/);
assert.throws(() => parseEditorTemplatePresets([{}]), /invalid editor preset/);

console.log("Tauri map source and editor IPC responses passed boundary checks.");
