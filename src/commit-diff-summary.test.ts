import assert from "node:assert/strict";
import test from "node:test";
import { commitDiffEntries, wrapCommitDiffIndex } from "./commit-diff-summary.js";
import type { CommitChanges } from "./map-source.js";
import type { DisplayBlock } from "./model.js";

const commit: CommitChanges["commit"] = {
  id: "c1",
  shortId: "abc1234",
  summary: "Example",
  timestamp: 0,
};

function block(id: string, label: string): DisplayBlock {
  return {
    id,
    label,
    type: "module",
    parentId: "crate:core",
    children: [],
    sourcePath: `src/${label}.rs`,
    fingerprint: "fp",
    packageName: "lightwell-core",
    modulePath: label,
    declaredByPath: "src/lib.rs",
    cfgAttributes: [],
    unresolved: false,
    description: `${label} module`,
    annotationKind: "MODULE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

test("commitDiffEntries lists direct blocks then unmapped files", () => {
  const changes: CommitChanges = {
    baseCommit: null,
    commit,
    blocks: [
      { blockId: "b:zebra", added: 1, removed: 0 },
      { blockId: "b:alpha", added: 2, removed: 3 },
    ],
    files: [
      { path: "README.md", oldPath: null, added: 4, removed: 0, binary: false },
      { path: "src/alpha.rs", oldPath: null, added: 2, removed: 3, binary: false },
    ],
    connections: [],
  };
  const blockById = new Map<string, DisplayBlock>([
    ["b:alpha", block("b:alpha", "alpha")],
    ["b:zebra", block("b:zebra", "zebra")],
  ]);
  const entries = commitDiffEntries(changes, blockById);
  assert.equal(entries.length, 3);
  const first = entries[0];
  const second = entries[1];
  const third = entries[2];
  assert.equal(first.kind, "block");
  if (first.kind === "block") assert.equal(first.label, "alpha");
  if (second.kind === "block") assert.equal(second.label, "zebra");
  assert.equal(third.kind, "file");
  assert.deepEqual(third, {
    kind: "file",
    path: "README.md",
    added: 4,
    removed: 0,
    binary: false,
  });
});

test("wrapCommitDiffIndex cycles within list length", () => {
  assert.equal(wrapCommitDiffIndex(-1, 3), 2);
  assert.equal(wrapCommitDiffIndex(3, 3), 0);
  assert.equal(wrapCommitDiffIndex(0, 0), 0);
});
