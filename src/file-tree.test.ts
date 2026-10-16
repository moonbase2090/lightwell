import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { blocksWithinDepth } from "./map-depth.js";
import {
  buildFileTree,
  collectRepoFiles,
  fileScopeCrumbs,
  fileScopeForBlock,
  isIgnoredRepoPath,
  defaultExpandedIds,
  explorerBadge,
  explorerPathTail,
  explorerRows,
  filterExplorerRows,
  treeBreadcrumb,
  treeDepth,
  parseGitignore,
  parseMapView,
  parseTreeOrientation,
  readMapView,
  readTreeOrientation,
  revealExpanded,
  rollupAlongParents,
  scopeDirectory,
  writeMapView,
  writeTreeOrientation,
  type DirEntry,
  type FileTreeSource,
  type MapViewStorage,
} from "./file-tree.js";

test("explorer path tails keep the last two path segments", () => {
  assert.equal(explorerPathTail(null), null);
  assert.equal(explorerPathTail(""), null);
  assert.equal(explorerPathTail("src/lib.rs"), "src/lib.rs");
  assert.equal(explorerPathTail("crates/core/src/main.rs"), "src/main.rs");
});

test("the map view defaults to modules and is stored per workspace", () => {
  assert.equal(parseMapView(null), "modules");
  assert.equal(parseMapView(""), "modules");
  assert.equal(parseMapView("files"), "files");
  assert.equal(parseMapView("all"), "modules");
  const storage = new MemoryStorage();
  writeMapView(storage, "/work/alpha", "files");
  writeMapView(storage, "/work/beta", "modules");
  assert.equal(readMapView(storage, "/work/alpha"), "files");
  assert.equal(readMapView(storage, "/work/beta"), "modules");
  assert.equal(readMapView(storage, "/work/gamma"), "modules");
  assert.equal(readMapView(null, "/work/alpha"), "modules");
});

test("tree orientation defaults to vertical and is stored per workspace", () => {
  assert.equal(parseTreeOrientation(null), "vertical");
  assert.equal(parseTreeOrientation(""), "vertical");
  assert.equal(parseTreeOrientation("vertical"), "vertical");
  assert.equal(parseTreeOrientation("sideways"), "vertical");
  assert.equal(parseTreeOrientation("horizontal"), "horizontal");
  const storage = new MemoryStorage();
  writeTreeOrientation(storage, "/work/alpha", "horizontal");
  writeTreeOrientation(storage, "/work/beta", "vertical");
  assert.equal(readTreeOrientation(storage, "/work/alpha"), "horizontal");
  assert.equal(readTreeOrientation(storage, "/work/beta"), "vertical");
  assert.equal(readTreeOrientation(storage, "/work/gamma"), "vertical");
  assert.equal(readTreeOrientation(null, "/work/alpha"), "vertical");
  const throwing: MapViewStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  assert.equal(readTreeOrientation(throwing, "/work/alpha"), "vertical");
  writeTreeOrientation(throwing, "/work/alpha", "horizontal");
});

test("a vertical file tree starts collapsed past the chosen depth", () => {
  const tree = buildFileTree(workspace, blocks, ["*.log"]);
  const root = tree.nodeById.get("workspace:demo");
  if (root === undefined) throw new Error("missing workspace");
  const depthOne = explorerRows(root, tree.nodeById, defaultExpandedIds(root, tree.nodeById, 1));
  assert.deepEqual(depthOne.map((row) => row.id), ["workspace:demo"]);

  const depthTwo = explorerRows(root, tree.nodeById, defaultExpandedIds(root, tree.nodeById, 2));
  assert.deepEqual(depthTwo.map((row) => row.id), [
    "workspace:demo",
    "dir:crates",
    "dir:pkg",
    "dir:web",
    "module:escape",
  ]);
  assert.equal(depthTwo.some((row) => row.id === "module:demo"), false);

  const opened = new Set(defaultExpandedIds(root, tree.nodeById, 2));
  opened.add("dir:crates");
  const afterCrates = explorerRows(root, tree.nodeById, opened);
  assert.equal(afterCrates.some((row) => row.id === "dir:crates%2Fdemo"), true);
  assert.equal(afterCrates.some((row) => row.id === "module:demo"), false);
  opened.add("dir:crates%2Fdemo");
  const afterDemo = explorerRows(root, tree.nodeById, opened);
  assert.equal(afterDemo.some((row) => row.id === "dir:crates%2Fdemo%2Fsrc"), true);
  assert.equal(afterDemo.some((row) => row.id === "module:demo"), false);

  const revealed = revealExpanded(new Set(), tree.nodeById, "module:demo");
  assert.equal(revealed.has("dir:crates"), true);
  assert.equal(revealed.has("dir:crates%2Fdemo"), true);
  assert.equal(revealed.has("dir:crates%2Fdemo%2Fsrc"), true);
  assert.equal(revealed.has("dir:pkg"), false);
  const revealedRows = explorerRows(root, tree.nodeById, revealed);
  assert.equal(revealedRows.some((row) => row.id === "module:demo"), true);
  assert.equal(revealedRows.some((row) => row.id === "module:py"), false);

  const allRows = explorerRows(root, tree.nodeById, defaultExpandedIds(root, tree.nodeById, "all"));
  assert.equal(allRows.some((row) => row.id === "module:demo"), true);
  assert.equal(allRows.some((row) => row.id === "module:web"), true);

  const filtered = filterExplorerRows(root, tree.nodeById, new Set(), "lib");
  assert.equal(filtered.some((row) => row.id === "module:demo"), true);
  assert.equal(filtered.some((row) => row.id === "dir:crates"), true);
  assert.equal(filtered.some((row) => row.id === "module:py"), false);
  assert.equal(filtered[0]?.id, "workspace:demo");
  assert.deepEqual(
    filterExplorerRows(root, tree.nodeById, new Set(), "   ").map((row) => row.id),
    ["workspace:demo"],
  );
  assert.equal(treeDepth(tree.nodeById, "module:demo") > 1, true);
  assert.equal(treeBreadcrumb(tree.nodeById, "module:demo")[0]?.id, "workspace:demo");
  assert.equal(treeBreadcrumb(tree.nodeById, "module:demo").at(-1)?.id, "module:demo");
});

test("explorer badges use the outline kind when a symbol has one", () => {
  assert.equal(explorerBadge({ folder: true }), "FILE");
  assert.equal(explorerBadge({ folder: false, blockType: "crate" }), "FILE");
  assert.equal(explorerBadge({ folder: false, blockType: "workspace" }), "FILE");
  assert.equal(explorerBadge({ folder: false, blockType: "module" }), "MOD");
  assert.equal(explorerBadge({ folder: false, blockType: "module", language: "rust", symbolKind: "const" }), "MOD");
  assert.equal(explorerBadge({ folder: false, blockType: "module", language: "python", symbolKind: "def" }), "FN");
  assert.equal(explorerBadge({ folder: false, blockType: "module", language: "python", symbolKind: "class" }), "TYPE");
  assert.equal(explorerBadge({ folder: false, blockType: "module", language: "typescript", symbolKind: "const" }), "CONST");
  assert.equal(explorerBadge({ folder: false, blockType: "module", language: "typescript", symbolKind: "function" }), "FN");
  assert.equal(explorerBadge({ folder: false, blockType: "app" }), "APP");
  assert.equal(explorerBadge({ folder: false, blockType: "cargo_feature" }), "FEAT");
});

test("a storage failure keeps the module view", () => {
  const storage: MapViewStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  assert.equal(readMapView(storage, "/work/alpha"), "modules");
  writeMapView(storage, "/work/alpha", "files");
});

test("Rust, TypeScript, and Python blocks group into folders", () => {
  const tree = buildFileTree(workspace, blocks, ["*.log"]);
  assert.equal(scopeDirectory("Cargo.toml"), "");
  assert.equal(scopeDirectory("crates/demo/Cargo.toml"), "crates/demo");
  assert.deepEqual(labels(tree, "workspace:demo"), ["crates", "pkg", "web", "outside"]);
  const root = tree.nodeById.get("workspace:demo");
  if (root === undefined) throw new Error("missing workspace");
  assert.deepEqual(blocksWithinDepth(root, 1, tree.nodeById).map((node) => node.id), ["workspace:demo"]);
  assert.deepEqual(blocksWithinDepth(root, 2, tree.nodeById).map((node) => node.id), [
    "workspace:demo",
    "dir:crates",
    "dir:pkg",
    "dir:web",
    "module:escape",
  ]);
  const demo = tree.nodeById.get("dir:crates%2Fdemo");
  assert.ok(demo !== undefined);
  assert.deepEqual(demo.children.map((id) => tree.nodeById.get(id)?.label), ["src", "default", "demo"]);
  assert.equal(tree.nodeById.has("module:demo"), true);
  assert.equal(tree.nodeById.has("module:web"), true);
  assert.equal(tree.nodeById.has("module:py"), true);
  assert.equal(tree.nodeById.has("module:target"), false);
  assert.equal(tree.nodeById.has("module:modules"), false);
  assert.equal(tree.nodeById.has("module:dist"), false);
  assert.equal(tree.nodeById.has("module:log"), false);
  assert.equal(tree.nodeById.has("module:escape"), true);
  assert.equal(tree.nodeById.get("module:escape")?.parentId, "workspace:demo");
  assert.equal(fileScopeForBlock("crates/demo/src/lib.rs", ""), "crates/demo/src");
  assert.equal(fileScopeForBlock("Cargo.toml", ""), "");
  assert.deepEqual(fileScopeCrumbs("crates/demo/src", ""), ["crates", "demo", "src"]);
  assert.deepEqual(fileScopeCrumbs("crates/demo/src", "crates/demo"), ["src"]);
});

test("a file-tree folder rolls up a commit diff from the file inside it", () => {
  const tree = buildFileTree(workspace, blocks, ["*.log"]);
  const rolled = rollupAlongParents(new Map([["module:demo", { added: 4, removed: 1 }]]), tree.parentOf);
  assert.equal(rolled.get("module:demo")?.direct, true);
  assert.equal(rolled.get("dir:crates%2Fdemo%2Fsrc")?.direct, false);
  assert.equal(rolled.get("dir:crates%2Fdemo%2Fsrc")?.added, 4);
  assert.equal(rolled.get("dir:pkg")?.added, undefined);
});

test("gitignore and build directories are left out of a fixture repo", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-file-tree-"));
  try {
    writeFixture(root);
    const rules = parseGitignore(readText(root, ".gitignore"));
    const files = collectRepoFiles((relativeDir) => listDir(root, relativeDir), rules);
    assert.deepEqual(files, [
      ".gitignore",
      "Cargo.toml",
      "crates/demo/Cargo.toml",
      "crates/demo/src/lib.rs",
      "pkg/demo.py",
      "secret/keep.rs",
      "src/lib.rs",
      "src/main.rs",
      "web/src/app.tsx",
    ]);
    assert.equal(isIgnoredRepoPath("dist/bundle.js", ["!dist/bundle.js"]), true);
    assert.equal(isIgnoredRepoPath("secret/keep.rs", rules), false);
    assert.equal(isIgnoredRepoPath("secret/hidden.rs", rules), true);
    assert.equal(isIgnoredRepoPath("notes.log", rules), true);

    const fixtureBlocks = new Map<string, FileTreeSource>();
    const childIds = files.concat([
      "target/debug/demo.rs",
      "node_modules/left-pad/index.js",
      "dist/bundle.js",
      "notes.log",
      "secret/hidden.rs",
    ]).filter((sourcePath) => sourcePath !== "Cargo.toml").map((sourcePath) => {
      const id = `file:${sourcePath}`;
      fixtureBlocks.set(id, { id, label: sourcePath, sourcePath, parentId: "workspace:fixture", children: [] });
      return id;
    });
    const rootBlock: FileTreeSource = {
      id: "workspace:fixture",
      label: "fixture",
      sourcePath: "Cargo.toml",
      parentId: null,
      children: childIds,
    };
    fixtureBlocks.set(rootBlock.id, rootBlock);
    const tree = buildFileTree(rootBlock, fixtureBlocks, rules);
    const present = tree.nodes.filter((node) => node.blockId !== null && node.id !== rootBlock.id).map((node) => node.sourcePath);
    present.sort();
    assert.deepEqual(present, files.filter((file) => file !== "Cargo.toml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const workspace: FileTreeSource = {
  id: "workspace:demo",
  label: "demo",
  sourcePath: "Cargo.toml",
  parentId: null,
  children: [
    "crate:demo",
    "module:web",
    "module:py",
    "module:target",
    "module:modules",
    "module:dist",
    "module:log",
    "module:escape",
  ],
};

const blocks = new Map<string, FileTreeSource>([
  [workspace.id, workspace],
  ["crate:demo", block("crate:demo", "demo", "crates/demo/Cargo.toml", "workspace:demo", ["module:demo", "feature:default"])],
  ["module:demo", block("module:demo", "lib", "crates/demo/src/lib.rs", "crate:demo", [])],
  ["feature:default", block("feature:default", "default", null, "crate:demo", [])],
  ["module:web", block("module:web", "app", "web/src/app.tsx", "workspace:demo", [])],
  ["module:py", block("module:py", "demo", "pkg/demo.py", "workspace:demo", [])],
  ["module:target", block("module:target", "debug", "target/debug/demo.rs", "workspace:demo", [])],
  ["module:modules", block("module:modules", "left-pad", "node_modules/left-pad/index.js", "workspace:demo", [])],
  ["module:dist", block("module:dist", "bundle", "dist/bundle.js", "workspace:demo", [])],
  ["module:log", block("module:log", "notes", "notes.log", "workspace:demo", [])],
  ["module:escape", block("module:escape", "outside", "../secrets.rs", "workspace:demo", [])],
]);

function block(id: string, label: string, sourcePath: string | null, parentId: string, children: readonly string[]): FileTreeSource {
  return { id, label, sourcePath, parentId, children };
}

function labels(tree: { readonly nodeById: ReadonlyMap<string, { readonly children: readonly string[]; readonly label: string }> }, id: string): string[] {
  const node = tree.nodeById.get(id);
  if (node === undefined) throw new Error(`missing ${id}`);
  return node.children.map((childId) => {
    const child = tree.nodeById.get(childId);
    if (child === undefined) throw new Error(`missing ${childId}`);
    return child.label;
  });
}

function writeFixture(root: string): void {
  writeFileSync(path.join(root, ".gitignore"), "*.log\nsecret/*\n!secret/keep.rs\n");
  writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"fixture\"\n");
  writeFileSync(path.join(root, "notes.log"), "noise\n");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "lib.rs"), "pub fn value() {}\n");
  writeFileSync(path.join(root, "src", "main.rs"), "fn main() {}\n");
  mkdirSync(path.join(root, "crates", "demo", "src"), { recursive: true });
  writeFileSync(path.join(root, "crates", "demo", "Cargo.toml"), "[package]\nname = \"demo\"\n");
  writeFileSync(path.join(root, "crates", "demo", "src", "lib.rs"), "pub fn demo() {}\n");
  mkdirSync(path.join(root, "web", "src"), { recursive: true });
  writeFileSync(path.join(root, "web", "src", "app.tsx"), "export {}\n");
  mkdirSync(path.join(root, "pkg"));
  writeFileSync(path.join(root, "pkg", "demo.py"), "def demo():\n    return 1\n");
  mkdirSync(path.join(root, "target", "debug"), { recursive: true });
  writeFileSync(path.join(root, "target", "debug", "demo.rs"), "");
  mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "");
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "bundle.js"), "");
  mkdirSync(path.join(root, "secret"));
  writeFileSync(path.join(root, "secret", "hidden.rs"), "");
  writeFileSync(path.join(root, "secret", "keep.rs"), "");
}

function readText(root: string, name: string): string {
  return readFileSync(path.join(root, name), "utf8");
}

function listDir(root: string, relativeDir: string): DirEntry[] {
  const absolute = relativeDir === "" ? root : path.join(root, relativeDir);
  return readdirSync(absolute, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    directory: entry.isDirectory(),
  }));
}

class MemoryStorage implements MapViewStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
