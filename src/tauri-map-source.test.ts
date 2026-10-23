import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseEditorSettings,
  parseEditorTemplatePresets,
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
  parseProjectNotesSnapshot,
  parseNotesGitStatus,
  parseNoteCommitResult,
  parseSourceFileDocument,
  parseWorkspaceMapUpdate,
} from "./map-sources/tauri-types.js";

const entry = { id: "/projects/lightwell", label: "Lightwell" };
const note = {
  blockId: "module:lightwell:workspace",
  text: "Keep the local extraction boundary clear.",
  sourceFingerprint: "fingerprint-1",
  stale: false,
};
const projectNotes = { kind: "ready", notes: [note] };
test("Tauri map, project notes, and editor IPC responses pass boundary checks", () => {
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
});


test("notes Git IPC validates states and commit receipts", () => {
  assert.deepEqual(parseNotesGitStatus({ kind: "ready", state: "mixed", revision: "abc", noteChanged: true }), {
    kind: "ready", state: "mixed", revision: "abc", noteChanged: true,
  });
  assert.deepEqual(parseNotesGitStatus({ kind: "ignored" }), { kind: "ignored" });
  assert.deepEqual(parseNotesGitStatus({ kind: "unavailable", message: "Install Git" }), { kind: "unavailable", message: "Install Git" });
  assert.deepEqual(parseNoteCommitResult({ commitId: null, status: { kind: "missing" } }), { commitId: null, status: { kind: "missing" } });
  for (const value of [{ kind: "ready", state: "unknown", revision: "abc", noteChanged: true }, { kind: "ready", state: "clean", revision: "", noteChanged: true }, { kind: "ready", state: "clean", revision: "abc", noteChanged: "false" }, { kind: "unavailable" }, { kind: "unknown" }]) {
    assert.throws(() => parseNotesGitStatus(value), /invalid notes Git status/);
  }
  assert.throws(() => parseNoteCommitResult({ commitId: "invalid", status: { kind: "missing" } }), /invalid note commit response/);
});
