import assert from "node:assert/strict";
import test from "node:test";
import { buildFileTree, type FileTreeSource } from "../file-tree.js";
import type { FactConnection } from "../model.js";
import { folderNodeId } from "../file-tree.js";
import {
  FOLDER_WEIGHT_CAP,
  atlasLabel,
  clampFrame,
  ellipsizeLabel,
  frameFocus,
  frameMatches,
  layoutAtlas,
  zoomAbout,
} from "./atlas-layout.js";
import { ancestorIds, atlasCellTone, buildAtlasLens } from "./atlas-lens.js";
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

test("focused lens counts containment and depends-on, and draws only depends-on curves", () => {
  const connections: FactConnection[] = [
    { id: "in", kind: "depends_on", source: "b", target: "a", dependencyScope: "normal" },
    { id: "out", kind: "depends_on", source: "a", target: "c", dependencyScope: "normal" },
    { id: "internal", kind: "depends_on", source: "a", target: "a", dependencyScope: "normal" },
    { id: "contains", kind: "contains", source: "root", target: "a" },
  ];
  const lens = buildAtlasLens(tree, connections, "a", 1);
  assert.deepEqual(lens.incoming.map((edge) => edge.id), ["contains", "in"]);
  assert.equal(lens.incoming.find((edge) => edge.id === "contains")?.kind, "contains");
  assert.deepEqual(lens.outgoing.map((edge) => edge.id), ["out"]);
  assert.deepEqual(lens.drawn.map((edge) => edge.id), ["in"]);
  assert.equal(lens.hiddenCount, 1);
  assert.equal(lens.dependsOnCount, 2);
  assert.deepEqual(lens.relatedBlockIds, new Set(["a", "b", "c", "root"]));
});

test("a module with no depends-on link still reports its parent contains edge", () => {
  const connections: FactConnection[] = [
    { id: "parent", kind: "contains", source: "root", target: "c" },
  ];
  const lens = buildAtlasLens(tree, connections, "c");
  assert.equal(lens.dependsOnCount, 0);
  assert.deepEqual(lens.incoming.map((edge) => edge.kind), ["contains"]);
  assert.equal(lens.outgoing.length, 0);
  assert.equal(lens.drawn.length, 0);
});

test("selection dims unrelated leaves and leaves ancestor folders at full strength", () => {
  assert.equal(atlasCellTone(
    { folder: false },
    { selected: false, focusActive: true, related: false, ancestor: false, searchMiss: false },
  ), "dimmed");
  assert.equal(atlasCellTone(
    { folder: true },
    { selected: false, focusActive: true, related: false, ancestor: true, searchMiss: false },
  ), "context");
  assert.equal(atlasCellTone(
    { folder: true },
    { selected: false, focusActive: true, related: false, ancestor: false, searchMiss: false },
  ), "rest");
  assert.equal(atlasCellTone(
    { folder: false },
    { selected: true, focusActive: true, related: true, ancestor: false, searchMiss: false },
  ), "selected");
  assert.deepEqual([...ancestorIds(tree, "a")], ["dir:src", "root"]);
});

test("labels ellipsize to the cell width and a short name is kept", () => {
  assert.equal(ellipsizeLabel("src", 80, 11), "src");
  const long = ellipsizeLabel("prismattyc-emulator", 48, 11);
  assert.ok(long.endsWith("…"));
  assert.ok(long.length < "prismattyc-emulator".length);
  assert.equal(ellipsizeLabel("prismattyc-emulator", 0, 11), "");
});

test("framing a tiny cell keeps it inside the atlas and larger than the cell", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const cell = { x: 100, y: 80, width: 4, height: 4 };
  const framed = frameFocus(cell, bounds, { x: 90, y: 70, width: 30, height: 24 });
  assert.ok(framed.width > cell.width * 3);
  assert.ok(framed.x <= cell.x && framed.x + framed.width >= cell.x + cell.width);
  assert.ok(framed.x >= bounds.x && framed.y >= bounds.y);
  assert.ok(framed.x + framed.width <= bounds.width + 0.01);
  assert.ok(framed.y + framed.height <= bounds.height + 0.01);
  const spread = frameMatches(
    [cell, { x: 700, y: 500, width: 10, height: 10 }],
    bounds,
  );
  assert.ok(spread.x <= cell.x && spread.x + spread.width >= cell.x + cell.width);
  const zoomed = zoomAbout(bounds, 0.5, 400, 300);
  assert.ok(zoomed.width < bounds.width);
  const restored = clampFrame(zoomAbout(zoomed, 2, 400, 300), bounds);
  assert.ok(Math.abs(restored.width - bounds.width) < 0.01);
  assert.ok(Math.abs(restored.height - bounds.height) < 0.01);
});

test("a release folder of many files stays within the leaf weight cap of a single crate file", () => {
  const releaseIds = Array.from({ length: 30 }, (_, index) => `rel-${index}`);
  const denseRoot = source("root", "Workspace", "Cargo.toml", null, ["crate-mod", ...releaseIds]);
  const denseBlocks = new Map<string, FileTreeSource>([[denseRoot.id, denseRoot]]);
  denseBlocks.set("crate-mod", source("crate-mod", "Crate", "crates/core/lib.ts", denseRoot.id, []));
  for (const id of releaseIds) {
    denseBlocks.set(id, source(id, id, `scripts/release/${id}.ts`, denseRoot.id, []));
  }
  const cells = layoutAtlas(buildFileTree(denseRoot, denseBlocks), 1000, 600);
  const release = cells.find((cell) => cell.id === folderNodeId("scripts/release"));
  const crates = cells.find((cell) => cell.id === folderNodeId("crates"));
  assert.ok(release !== undefined && crates !== undefined);
  const ratio = (release.width * release.height) / (crates.width * crates.height);
  assert.ok(ratio <= FOLDER_WEIGHT_CAP + 2, `release/crate area ratio ${ratio}`);
  assert.ok(ratio > 8, `release/crate area ratio ${ratio}`);
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


test("atlas fit shows top-level groups and keeps file and nested labels hidden", () => {
  const cell = { label: "module", width: 400, height: 100, depth: 1, folder: true };
  assert.equal(atlasLabel(cell, 1, 11), "module");
  assert.equal(atlasLabel({ ...cell, depth: 0 }, 1, 11), "module");
  assert.equal(atlasLabel({ ...cell, depth: 2 }, 1, 11), "");
  assert.equal(atlasLabel({ ...cell, folder: false }, 1, 11), "");
});

test("atlas label detail follows on-screen dimensions and configured text size", () => {
  const cell = { label: "long-module-name", width: 40, height: 20, depth: 4, folder: false };
  assert.equal(atlasLabel(cell, 1.2, 11), "");
  assert.equal(atlasLabel(cell, 4, 11), "long-module-n…");
  assert.equal(atlasLabel(cell, 6, 11), "long-module-name");
  assert.equal(atlasLabel({ ...cell, width: 200, height: 3 }, 2, 11), "");
  assert.equal(atlasLabel({ ...cell, width: 200, height: 10 }, 2, 11), "long-module-name");
  assert.equal(atlasLabel({ ...cell, width: 200, height: 10 }, 2, 18), "");
});
