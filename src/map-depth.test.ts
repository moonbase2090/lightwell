import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAP_DEPTH,
  blocksWithinDepth,
  depthOptions,
  parseMapDepth,
  readMapDepth,
  subtreeDepth,
  writeMapDepth,
  type DepthNode,
  type MapDepthStorage,
} from "./map-depth.js";

const tree = new Map<string, DepthNode>([
  ["root", { id: "root", children: ["crate", "missing"] }],
  ["crate", { id: "crate", children: ["module"] }],
  ["module", { id: "module", children: ["fn", "root"] }],
  ["fn", { id: "fn", children: [] }],
]);

function ids(depth: number | "all"): string[] {
  const root = tree.get("root");
  if (root === undefined) throw new Error("missing root");
  return blocksWithinDepth(root, depth, tree).map((block) => block.id);
}

test("the default depth is two levels", () => {
  assert.equal(DEFAULT_MAP_DEPTH, 2);
  assert.deepEqual(ids(2), ["root", "crate"]);
});

test("depth one shows only the current block", () => {
  assert.deepEqual(ids(1), ["root"]);
});

test("a deeper limit includes descendants and skips a missing child", () => {
  assert.deepEqual(ids(3), ["root", "crate", "module"]);
});

test("all includes every reachable block once", () => {
  assert.deepEqual(ids("all"), ["root", "crate", "module", "fn"]);
  const root = tree.get("root");
  if (root === undefined) throw new Error("missing root");
  assert.equal(subtreeDepth(root, tree), 4);
});

test("an unusable stored depth falls back to the default", () => {
  assert.equal(parseMapDepth(null), 2);
  assert.equal(parseMapDepth(""), 2);
  assert.equal(parseMapDepth("0"), 2);
  assert.equal(parseMapDepth("1.5"), 2);
  assert.equal(parseMapDepth("all"), "all");
  assert.equal(parseMapDepth("4"), 4);
});

test("depth is remembered separately for each workspace", () => {
  const storage = new MemoryStorage();
  writeMapDepth(storage, "/work/alpha", 3);
  writeMapDepth(storage, "/work/beta", "all");
  assert.equal(readMapDepth(storage, "/work/alpha"), 3);
  assert.equal(readMapDepth(storage, "/work/beta"), "all");
  assert.equal(readMapDepth(storage, "/work/gamma"), 2);
  assert.equal(readMapDepth(null, "/work/alpha"), 2);
});

test("a storage failure keeps the default", () => {
  const storage: MapDepthStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  assert.equal(readMapDepth(storage, "/work/alpha"), 2);
  writeMapDepth(storage, "/work/alpha", 4);
});

test("the control lists each level through the tree and All", () => {
  assert.deepEqual(depthOptions(4, 2), [1, 2, 3, 4, "all"]);
  assert.deepEqual(depthOptions(2, "all"), [1, 2, "all"]);
});

class MemoryStorage implements MapDepthStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
