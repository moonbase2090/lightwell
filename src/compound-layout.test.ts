import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import ElkConstructor from "elkjs/lib/elk.bundled.js";
import {
  DEFAULT_COMPOUND_LAYOUT_LIMITS,
  createCompoundLayoutEngine,
  type CompoundLayoutBlock,
  type CompoundLayoutInput,
  type CompoundLayoutResult,
  type LayoutBounds,
} from "./viewer/compound-layout.js";
import { createCompoundLayoutFeature } from "./viewer/compound-layout-client.js";

function createTestEngine() {
  return createCompoundLayoutEngine(new ElkConstructor());
}

function block(
  id: string,
  parentId: string | null,
  type: CompoundLayoutBlock["type"],
  children: readonly string[] = [],
): CompoundLayoutBlock {
  return { id, parentId, type, children };
}

function dependency(id: string, source: string, target: string) {
  return { id, source, target };
}

function node(result: CompoundLayoutResult, id: string) {
  const found = result.nodes.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing layout node ${id}`);
  return found;
}

function interiorsOverlap(left: LayoutBounds, right: LayoutBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function inside(child: LayoutBounds, parent: LayoutBounds): boolean {
  return child.x >= parent.x
    && child.y >= parent.y
    && child.x + child.width <= parent.x + parent.width
    && child.y + child.height <= parent.y + parent.height;
}

function rectGap(left: LayoutBounds, right: LayoutBounds): number {
  const horizontal = Math.max(0, left.x - right.x - right.width, right.x - left.x - left.width);
  const vertical = Math.max(0, left.y - right.y - right.height, right.y - left.y - left.height);
  return Math.max(horizontal, vertical);
}

function segmentCrossesInterior(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  bounds: LayoutBounds,
): boolean {
  if (start.x === end.x) {
    return start.x > bounds.x
      && start.x < bounds.x + bounds.width
      && Math.max(start.y, end.y) > bounds.y
      && Math.min(start.y, end.y) < bounds.y + bounds.height;
  }
  if (start.y === end.y) {
    return start.y > bounds.y
      && start.y < bounds.y + bounds.height
      && Math.max(start.x, end.x) > bounds.x
      && Math.min(start.x, end.x) < bounds.x + bounds.width;
  }
  return true;
}

function nestedFixture(): CompoundLayoutInput {
  return {
    rootId: "workspace:demo",
    blocks: [
      block("workspace:demo", null, "workspace", ["crate:app", "crate:core"]),
      block("crate:app", "workspace:demo", "crate", ["app:cli", "module:command", "module:format"]),
      block("app:cli", "crate:app", "app"),
      block("module:command", "crate:app", "module"),
      block("module:format", "crate:app", "module"),
      block("crate:core", "workspace:demo", "crate", ["module:model", "module:parse"]),
      block("module:model", "crate:core", "module"),
      block("module:parse", "crate:core", "module"),
    ],
    connections: [
      dependency("app-to-command", "app:cli", "module:command"),
      dependency("command-to-model", "module:command", "module:model"),
      dependency("format-to-parse", "module:format", "module:parse"),
      dependency("parse-to-model", "module:parse", "module:model"),
    ],
    limits: DEFAULT_COMPOUND_LAYOUT_LIMITS,
  };
}

test("compound layout nests children without overlap and keeps nearby siblings compact", async () => {
  const result = await createTestEngine().layout(nestedFixture());
  const workspace = node(result, "workspace:demo");
  const appCrate = node(result, "crate:app");
  const coreCrate = node(result, "crate:core");

  assert.equal(appCrate.parentId, workspace.id);
  assert.equal(coreCrate.parentId, workspace.id);
  assert.equal(inside(appCrate.bounds, workspace.bounds), true);
  assert.equal(inside(coreCrate.bounds, workspace.bounds), true);
  assert.equal(interiorsOverlap(appCrate.bounds, coreCrate.bounds), false);

  for (const parentId of [workspace.id, appCrate.id, coreCrate.id]) {
    const siblings = result.nodes.filter((candidate) => candidate.parentId === parentId);
    for (let index = 0; index < siblings.length; index += 1) {
      const current = siblings[index];
      assert.ok(current !== undefined);
      for (const other of siblings.slice(index + 1)) {
        assert.equal(interiorsOverlap(current.bounds, other.bounds), false, `${current.id} overlaps ${other.id}`);
      }
      if (siblings.length > 1) {
        const nearest = Math.min(...siblings.filter((other) => other.id !== current.id).map((other) => rectGap(current.bounds, other.bounds)));
        assert.ok(nearest <= 64, `${current.id} has a ${nearest}px nearest-sibling gap`);
      }
    }
  }

  assert.ok(node(result, "app:cli").bounds.y <= node(result, "module:format").bounds.y);
});

test("dependencies aggregate at their lowest common group and retain source facts", async () => {
  const result = await createTestEngine().layout(nestedFixture());
  const crossGroup = result.edges.find((edge) => edge.groupId === "workspace:demo");
  const insideCore = result.edges.find((edge) => edge.groupId === "crate:core");

  assert.ok(crossGroup !== undefined);
  assert.equal(crossGroup.source, "crate:app");
  assert.equal(crossGroup.target, "crate:core");
  assert.deepEqual(crossGroup.sourceEdgeIds, ["command-to-model", "format-to-parse"]);
  assert.equal(crossGroup.label, "depends on (2)");

  assert.ok(insideCore !== undefined);
  assert.equal(insideCore.source, "module:parse");
  assert.equal(insideCore.target, "module:model");
  assert.deepEqual(insideCore.sourceEdgeIds, ["parse-to-model"]);
  assert.equal(insideCore.label, "depends on");
});

test("dependency routes are orthogonal and avoid unrelated sibling interiors", async () => {
  const result = await createTestEngine().layout(nestedFixture());
  for (const edge of result.edges) {
    const obstacles = result.nodes.filter((candidate) => candidate.parentId === edge.groupId
      && candidate.id !== edge.source
      && candidate.id !== edge.target);
    assert.ok(edge.points.length >= 2, `${edge.id} has no route`);
    for (let index = 1; index < edge.points.length; index += 1) {
      const start = edge.points[index - 1];
      const end = edge.points[index];
      assert.ok(start !== undefined && end !== undefined);
      assert.ok(start.x === end.x || start.y === end.y, `${edge.id} contains a diagonal segment`);
      for (const obstacle of obstacles) {
        assert.equal(
          segmentCrossesInterior(start, end, obstacle.bounds),
          false,
          `${edge.id} crosses ${obstacle.id}`,
        );
      }
    }
  }
});

test("a small dependency chain does not spread unrelated siblings across its rank", async () => {
  const childIds = Array.from({ length: 20 }, (_, index) => `module:${index}`);
  const result = await createTestEngine().layout({
    rootId: "workspace:compact",
    blocks: [
      block("workspace:compact", null, "workspace", childIds),
      ...childIds.map((id) => block(id, "workspace:compact", "module")),
    ],
    connections: [dependency("one-chain", "module:0", "module:1")],
    limits: DEFAULT_COMPOUND_LAYOUT_LIMITS,
  });

  assert.ok(node(result, "workspace:compact").bounds.width <= 1_600);
});

test("the engine reuses unchanged group layouts and invalidates their changed ancestor", async () => {
  const engine = createTestEngine();
  const input = nestedFixture();
  const first = await engine.layout(input);
  const second = await engine.layout(input);
  const changed = await engine.layout({
    ...input,
    connections: [...input.connections, dependency("app-to-core", "app:cli", "module:parse")],
  });
  const retyped = await engine.layout({
    ...input,
    blocks: input.blocks.map((candidate) => candidate.id === input.rootId
      ? { ...candidate, type: "module" }
      : candidate),
  });

  assert.ok(first.stats.cacheMisses > 0);
  assert.equal(first.stats.cacheHits, 0);
  assert.ok(second.stats.cacheHits > 0);
  assert.equal(second.stats.cacheMisses, 0);
  assert.ok(changed.stats.cacheHits > 0);
  assert.ok(changed.stats.cacheMisses > 0);
  const retypedRoot = node(retyped, input.rootId);
  assert.ok(retypedRoot.kind === "block");
  assert.equal(retypedRoot.blockType, "module");
  assert.ok(retyped.stats.cacheMisses > 0);
});

test("the engine bounds cached group layouts across distinct workspaces", async () => {
  const engine = createTestEngine();
  let result: CompoundLayoutResult | undefined;
  for (let index = 0; index < 320; index += 1) {
    const rootId = `workspace:cache-${index}`;
    result = await engine.layout({
      rootId,
      blocks: [
        block(rootId, null, "workspace", [`module:${index}`]),
        block(`module:${index}`, rootId, "module"),
      ],
      connections: [],
      limits: DEFAULT_COMPOUND_LAYOUT_LIMITS,
    });
  }

  assert.ok(result !== undefined);
  assert.ok(result.stats.cacheEntries <= 256);
});

test("a 5,000-block workspace stays inside the block budget and finishes within five seconds", async () => {
  const childIds = Array.from({ length: 4_999 }, (_, index) => `module:${index}`);
  const input: CompoundLayoutInput = {
    rootId: "workspace:large",
    blocks: [
      block("workspace:large", null, "workspace", childIds),
      ...childIds.map((id) => block(id, "workspace:large", "module")),
    ],
    connections: [],
    limits: DEFAULT_COMPOUND_LAYOUT_LIMITS,
  };
  const started = performance.now();
  const result = await createTestEngine().layout(input);
  const elapsed = performance.now() - started;

  assert.ok(result.stats.renderedBlocks <= DEFAULT_COMPOUND_LAYOUT_LIMITS.maxBlocks);
  assert.ok(result.stats.omittedBlocks >= 4_200);
  assert.ok(result.nodes.some((candidate) => candidate.kind === "summary"));
  assert.ok(elapsed < 5_000, `bounded layout took ${Math.round(elapsed)}ms`);
});

test("the edge budget limits routed dependencies", async () => {
  const input = nestedFixture();
  const result = await createTestEngine().layout({
    ...input,
    limits: { maxBlocks: 20, maxEdges: 1 },
  });

  assert.equal(result.stats.renderedEdges, 1);
  assert.equal(result.stats.omittedEdges, 3);
  assert.equal(result.edges.length, 1);
});

test("a collapsed summary keeps dependencies from omitted children", async () => {
  const result = await createTestEngine().layout({
    rootId: "workspace:bounded",
    blocks: [
      block("workspace:bounded", null, "workspace", ["module:a", "module:b", "module:c"]),
      block("module:a", "workspace:bounded", "module"),
      block("module:b", "workspace:bounded", "module"),
      block("module:c", "workspace:bounded", "module"),
    ],
    connections: [dependency("hidden-to-visible", "module:b", "module:a")],
    limits: { maxBlocks: 3, maxEdges: 10 },
  });
  const summary = result.nodes.find((candidate) => candidate.kind === "summary");
  assert.ok(summary !== undefined);
  const edge = result.edges[0];
  assert.ok(edge !== undefined);
  assert.equal(edge.source, summary.id);
  assert.equal(edge.target, "module:a");
  assert.deepEqual(edge.sourceEdgeIds, ["hidden-to-visible"]);
});

test("the default-off feature does not construct a browser worker", () => {
  assert.deepEqual(createCompoundLayoutFeature(undefined), { kind: "disabled" });
  assert.deepEqual(createCompoundLayoutFeature("false"), { kind: "disabled" });
});
