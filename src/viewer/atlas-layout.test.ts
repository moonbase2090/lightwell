import assert from "node:assert/strict";
import test from "node:test";
import { buildFileTree, type FileTreeSource } from "../file-tree.js";
import type { FactConnection } from "../model.js";
import { layoutAtlas } from "./atlas-layout.js";
import { buildAtlasLens } from "./atlas-lens.js";
import { matchingOutline } from "./AtlasView.js";

function source(id: string, label: string, path: string | null, parentId: string | null, children: readonly string[]): FileTreeSource {
  return { id, label, sourcePath: path, parentId, children };
}

const root = source("root", "Workspace", "Cargo.toml", null, ["a", "b", "c"]);
const blocks = new Map<string, FileTreeSource>([
  [root.id, root],
  ["a", source("a", "Alpha", "src/alpha.ts", "root", [])],
  ["b", source("b", "Beta", "src/beta.ts", "root", [])],
  ["c", source("c", "Gamma", "tests/gamma.ts", "root", [])],
]);
const tree = buildFileTree(root, blocks);

test("atlas layout is deterministic, bounded, and preserves every outline node", () => {
  const first = layoutAtlas(tree, 1000, 600);
  const second = layoutAtlas(tree, 1000, 600);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((cell) => cell.id)), new Set(tree.nodes.map((node) => node.id)));
  for (const cell of first) {
    assert.ok(cell.x >= 0 && cell.y >= 0, cell.id);
    assert.ok(cell.x + cell.width <= 1000.001, cell.id);
    assert.ok(cell.y + cell.height <= 600.001, cell.id);
  }
  const alpha = first.find((cell) => cell.id === "a");
  const beta = first.find((cell) => cell.id === "b");
  assert.notDeepEqual(alpha, beta);
});

test("atlas layout retains deeply grouped nodes after their regions become too small to label", () => {
  const childIds = Array.from({ length: 100 }, (_, index) => `block-${index}`);
  const denseRoot = source("dense-root", "Dense", "package.json", null, childIds);
  const denseBlocks = new Map<string, FileTreeSource>([[denseRoot.id, denseRoot]]);
  for (const [index, id] of childIds.entries()) {
    denseBlocks.set(id, source(id, `Block ${index}`, `src/group-${index}/deep/file.ts`, denseRoot.id, []));
  }
  const denseTree = buildFileTree(denseRoot, denseBlocks);
  const denseCells = layoutAtlas(denseTree, 200, 100);
  assert.equal(denseCells.length, denseTree.nodes.length);
  assert.deepEqual(new Set(denseCells.map((cell) => cell.id)), new Set(denseTree.nodes.map((node) => node.id)));
});

test("atlas layout leaves positive drawable space through deep folder nesting", () => {
  const path = `${Array.from({ length: 40 }, (_, index) => `level-${index}`).join("/")}/file.ts`;
  const deepRoot = source("deep-root", "Deep", "package.json", null, ["deep-block"]);
  const deepTree = buildFileTree(deepRoot, new Map([
    [deepRoot.id, deepRoot],
    ["deep-block", source("deep-block", "Deep block", path, deepRoot.id, [])],
  ]));
  const cells = layoutAtlas(deepTree, 200, 100);
  assert.equal(cells.length, deepTree.nodes.length);
  for (const cell of cells) {
    assert.ok(cell.width > 0, `${cell.id} has positive width`);
    assert.ok(cell.height > 0, `${cell.id} has positive height`);
  }
});

test("focused lens keeps exact incoming and outgoing dependencies while capping drawn edges", () => {
  const connections: FactConnection[] = [
    { id: "in", kind: "depends_on", source: "b", target: "a", dependencyScope: "normal" },
    { id: "out", kind: "depends_on", source: "a", target: "c", dependencyScope: "normal" },
    { id: "internal", kind: "depends_on", source: "a", target: "a", dependencyScope: "normal" },
    { id: "contains", kind: "contains", source: "root", target: "a" },
  ];
  const lens = buildAtlasLens(tree, connections, "a", 1);
  assert.deepEqual(lens.incoming.map((edge) => edge.id), ["in"]);
  assert.deepEqual(lens.outgoing.map((edge) => edge.id), ["out"]);
  assert.equal(lens.drawn.length, 1);
  assert.equal(lens.hiddenCount, 1);
  assert.deepEqual(lens.relatedBlockIds, new Set(["a", "b", "c"]));
});

test("atlas outline respects expansion and keeps ancestors of search matches", () => {
  assert.deepEqual(matchingOutline(tree, new Set(["root"]), "").map((row) => row.node.id), ["root", "dir:src", "dir:tests"]);
  assert.deepEqual(matchingOutline(tree, new Set(), "Alpha").map((row) => row.node.id), ["root", "dir:src", "a"]);
  const alpha = matchingOutline(tree, new Set(), "Alpha").at(-1);
  assert.equal(alpha?.level, 3);
  assert.equal(alpha?.position, 1);
  assert.equal(alpha?.setSize, 2);
});

test("atlas outline keeps only changed branches without losing their ancestors", () => {
  const changedIds = new Set(["root", "dir:src", "a"]);
  assert.deepEqual(
    matchingOutline(tree, new Set(), "", changedIds).map((row) => row.node.id),
    ["root", "dir:src", "a"],
  );
});
