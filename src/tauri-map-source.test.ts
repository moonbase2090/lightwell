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
  parseResolvedCommitRange,
  parseWorkspaceNotesUpdate,
  parseLanguagePackCatalog,
} from "./map-sources/tauri-types.js";

const entry = { id: "/projects/lightwell", label: "Lightwell" };
const note = {
  blockId: "module:lightwell:workspace",
  text: "Keep the local extraction boundary clear.",
  sourceFingerprint: "fingerprint-1",
  author: "preview",
  updatedAt: "2026-10-25T03:00:00Z",
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
  const revised = { ...note, revision: "abc123" };
  assert.deepEqual(parseProjectNotesSnapshot({ kind: "ready", notes: [revised] }), { kind: "ready", notes: [revised] });
  assert.throws(() => parseProjectNotesSnapshot({ kind: "ready", notes: [{ ...note, revision: "" }] }), /invalid project note/);
  assert.deepEqual(parseWorkspaceNotesUpdate({ path: entry.id, projectNotes }), { path: entry.id, projectNotes });
  assert.throws(() => parseWorkspaceNotesUpdate({ path: "", projectNotes }), /invalid notes update/);
  assert.deepEqual(parseProjectNotesSnapshot({ kind: "error", message: "Could not read notes." }), {
    kind: "error",
    message: "Could not read notes.",
  });
  assert.throws(() => parseMapSourceEntry({ id: entry.id, label: 3 }), /invalid workspace entry/);
  assert.throws(() => parseMapSourceEntries({}), /invalid recent workspaces list/);
  assert.throws(() => parseMapSourceDocument({ facts: {} }), /invalid workspace map/);
  assert.throws(() => parseWorkspaceMapUpdate({ workspaceId: entry.id, document: {} }), /invalid workspace map/);
  assert.throws(() => parseProjectNotesSnapshot({ kind: "ready", notes: [{ ...note, stale: "false" }] }), /invalid project note/);
  assert.throws(() => parseProjectNotesSnapshot({ kind: "ready", notes: [{ ...note, author: "" }] }), /invalid project note/);
  assert.throws(() => parseProjectNotesSnapshot({ kind: "ready", notes: [{ ...note, updatedAt: 1 }] }), /invalid project note/);
  assert.deepEqual(parseProjectNotesSnapshot({ kind: "ready", notes: [{ ...note, updatedAt: "" }] }), {
    kind: "ready",
    notes: [{ ...note, updatedAt: "" }],
  });
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

test("language pack IPC parses loaded and invalid entries", () => {
  const catalog = {
    revision: 3,
    userPacksDirectory: "/redacted/language-packs",
    entries: [
      {
        kind: "loaded",
        id: "demo",
        packVersion: "1.0.0",
        origin: "user",
        manifestPath: "/redacted/language-packs/demo/language-pack.json",
        manifest: {
          schemaVersion: 1,
          id: "demo",
          packVersion: "1.0.0",
          extensions: [".demo"],
          basenames: ["DemoFile"],
          basenamePrefixes: [],
          monaco: { id: "plaintext", highlighter: null, byExtension: {}, byBasename: {}, byBasenamePrefix: {} },
          extractors: { source: null, workspace: null },
          fixtures: null,
        },
      },
      {
        kind: "error",
        errorId: "user:broken",
        origin: "user",
        manifestPath: "/redacted/language-packs/broken/language-pack.json",
        code: "parse",
        message: "Expected a JSON object.",
      },
    ],
  };
  assert.deepEqual(parseLanguagePackCatalog(catalog), catalog);
  assert.throws(() => parseLanguagePackCatalog({ ...catalog, revision: -1 }), /invalid language pack catalog/);
  assert.throws(() => parseLanguagePackCatalog({ ...catalog, entries: [{ ...catalog.entries[0], origin: "remote" }] }), /invalid loaded language pack/);
  assert.throws(() => parseLanguagePackCatalog({ ...catalog, entries: [{ ...catalog.entries[0], packVersion: "latest" }] }), /invalid loaded language pack/);
  assert.throws(() => parseLanguagePackCatalog({ ...catalog, entries: [{ ...catalog.entries[1], code: "missing" }] }), /invalid language pack error/);
  assert.throws(() => parseLanguagePackCatalog({ ...catalog, entries: [{ ...catalog.entries[0], manifest: { extensions: ".demo", basenames: [], basenamePrefixes: [] } }] }), /Invalid language pack manifest/);
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

test("range IPC preserves exact count and endpoints and rejects impossible empty ranges", () => {
  const commit = { id: "new", shortId: "new", summary: "Newer", timestamp: 2 };
  const baseCommit = { id: "old", shortId: "old", summary: "Older", timestamp: 1 };
  assert.deepEqual(parseResolvedCommitRange({ commit, baseCommit, commitCount: 7, releaseTag: "v1.0.0" }), {
    commit, baseCommit, commitCount: 7, releaseTag: "v1.0.0",
  });
  for (const bad of [
    { commit, baseCommit, commitCount: -1, releaseTag: null },
    { commit, baseCommit, commitCount: "7", releaseTag: null },
    { commit, baseCommit: null, commitCount: 7, releaseTag: null },
    { commit, baseCommit, commitCount: 0, releaseTag: "v1.0.0" },
    { commit, baseCommit: commit, commitCount: 0, releaseTag: null },
  ]) assert.throws(() => parseResolvedCommitRange(bad), /commit range/);
});
