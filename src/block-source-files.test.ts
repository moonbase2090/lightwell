import assert from "node:assert/strict";
import test from "node:test";
import type { FactBlock, ModuleBlock } from "./model.js";
import { blockSourceFiles } from "./block-source-files.js";

function block(id: string, sourcePath: string | null, children: readonly string[] = []): ModuleBlock {
  return { id, label: id, sourcePath, children, type: "module", parentId: null, fingerprint: "fp", packageName: "fixture", modulePath: id, declaredByPath: "src/lib.rs", cfgAttributes: [], unresolved: false };
}

test("lists a block's mapped descendant files once, primary first and siblings excluded", () => {
  const blocks: FactBlock[] = [
    block("owner", "src/lib.rs", ["z", "inline", "a", "missing"]),
    block("z", "src/z.rs"),
    block("inline", "src/lib.rs"),
    block("a", "src/a.rs", ["nested"]),
    block("nested", "src/nested.rs"),
    block("unrelated", "src/other.rs"),
  ];
  const map = new Map(blocks.map((value) => [value.id, value]));
  assert.deepEqual(blockSourceFiles("owner", map), [
    { blockId: "owner", path: "src/lib.rs" },
    { blockId: "a", path: "src/a.rs" },
    { blockId: "nested", path: "src/nested.rs" },
    { blockId: "z", path: "src/z.rs" },
  ]);
  assert.deepEqual(blockSourceFiles("z", map), [{ blockId: "z", path: "src/z.rs" }]);
  assert.deepEqual(blockSourceFiles("absent", map), []);
});

test("resolves module declaration fallbacks and terminates cyclic containment", () => {
  const blocks = [block("owner", null, ["same", "child"]), block("same", "src\\lib.rs"), block("child", "src/child.rs", ["owner"])];
  assert.deepEqual(blockSourceFiles("owner", new Map(blocks.map((value) => [value.id, value]))), [
    { blockId: "owner", path: "src/lib.rs" },
    { blockId: "child", path: "src/child.rs" },
  ]);
});
