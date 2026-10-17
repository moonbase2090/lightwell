import assert from "node:assert/strict";
import test from "node:test";
import { connectionChangesById, rollUpChanges, unmappedFiles } from "./commit-diff.js";
import { commitDiffEnabled } from "./feature-flags.js";
import type { CommitChanges } from "./map-source.js";
import { parseBlockDiffDocument, parseCommitChanges } from "./map-sources/tauri-types.js";

// workspace > crate > module (job.py) > { plan, merge }; crate > other.rs
const parents: Record<string, string | null> = {
  workspace: null,
  crate: "workspace",
  module: "crate",
  plan: "module",
  merge: "module",
  other: "crate",
};
const parentOf = (id: string) => parents[id];

const changes = (
  blocks: CommitChanges["blocks"],
  files: CommitChanges["files"] = [],
  connections: CommitChanges["connections"] = [],
): CommitChanges => ({
  baseCommit: null,
  commit: { id: "a41f9c2", shortId: "a41f9c2", summary: "Split layout", timestamp: 0 },
  files,
  blocks,
  connections,
});

test("ancestors light up with the counts of the blocks inside them", () => {
  const diff = rollUpChanges(changes([{ blockId: "other", added: 4, removed: 1 }]), parentOf);
  assert.deepEqual(diff.get("other"), { added: 4, removed: 1, direct: true });
  assert.deepEqual(diff.get("crate"), { added: 4, removed: 1, direct: false });
  assert.deepEqual(diff.get("workspace"), { added: 4, removed: 1, direct: false });
  assert.equal(diff.has("module"), false);
});

test("a module and its symbols sharing one file are counted once above the module", () => {
  const diff = rollUpChanges(changes([
    { blockId: "module", added: 2, removed: 1 },
    { blockId: "merge", added: 2, removed: 1 },
  ]), parentOf);
  assert.deepEqual(diff.get("module"), { added: 2, removed: 1, direct: true });
  assert.deepEqual(diff.get("crate"), { added: 2, removed: 1, direct: false });
  assert.equal(diff.has("plan"), false);
});

test("connection changes are keyed by edge id for the graph", () => {
  const map = connectionChangesById(changes([], [], [
    { id: "depends:crate:a->crate:b", source: "crate:a", target: "crate:b", kind: "depends_on", state: "removed" },
  ]));
  assert.equal(map.get("depends:crate:a->crate:b"), "removed");
  assert.equal(map.size, 1);
});

test("changed files without a block are reported", () => {
  const files = [
    { path: "scripts/job.py", oldPath: null, added: 2, removed: 1, binary: false },
    { path: "NOTES.txt", oldPath: null, added: 1, removed: 0, binary: false },
  ];
  assert.deepEqual(unmappedFiles(changes([], files), new Set(["scripts/job.py"])), ["NOTES.txt"]);
});

test("the commit diff view is off unless the flag is exactly true", () => {
  assert.equal(commitDiffEnabled(undefined), false);
  assert.equal(commitDiffEnabled("1"), false);
  assert.equal(commitDiffEnabled("false"), false);
  assert.equal(commitDiffEnabled("true"), true);
});

test("commit changes from the desktop app are validated", () => {
  const valid = {
    baseCommit: null,
    commit: { id: "abc", shortId: "abc", summary: "x", timestamp: 1 },
    files: [{ path: "a.py", oldPath: null, added: 1, removed: 0, binary: false }],
    blocks: [{ blockId: "module:a", added: 1, removed: 0 }],
    connections: [{ id: "contains:a->b", source: "a", target: "b", kind: "contains", state: "added" }],
  };
  assert.equal(parseCommitChanges(valid).blocks[0]?.blockId, "module:a");
  assert.deepEqual(
    parseCommitChanges({
      ...valid,
      baseCommit: { id: "def", shortId: "def", summary: "base", timestamp: 0 },
    }).baseCommit?.shortId,
    "def",
  );
  assert.throws(() => parseCommitChanges({ ...valid, blocks: [{ blockId: "x", added: -1, removed: 0 }] }));
  assert.throws(() => parseCommitChanges({ ...valid, commit: { id: "abc" } }));
});

test("block diffs from the desktop app are validated", () => {
  const valid = {
    commit: { id: "abc", shortId: "abc", summary: "x", timestamp: 1 },
    path: "scripts/job.py",
    originalPath: null,
    original: "def merge():\n    return 2\n",
    modified: "def merge():\n    total = 2\n    return total\n",
    line: 2,
  };
  const parsed = parseBlockDiffDocument(valid);
  assert.equal(parsed.line, 2);
  assert.equal(parsed.originalPath, null);
  assert.throws(() => parseBlockDiffDocument({ ...valid, line: 0 }));
  assert.throws(() => parseBlockDiffDocument({ ...valid, modified: undefined }));
});
