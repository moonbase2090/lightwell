import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutBlocks, maxNodesPerRow, wrapWideLayers } from "./layout.js";
import type { DisplayBlock } from "../model.js";

const nodeWidth = 222;
const nodeHeight = 94;

function widestRow(positions: Iterable<{ readonly y: number }>): number {
  const perY = new Map<number, number>();
  for (const position of positions) perY.set(position.y, (perY.get(position.y) ?? 0) + 1);
  return Math.max(...perY.values());
}

function row(count: number, y: number, startId = 0) {
  return Array.from({ length: count }, (_, index) => [`n${startId + index}`, { x: index * 236, y }] as const);
}

test("a layer wider than the row cap wraps into rows no wider than the cap", () => {
  const wrapped = wrapWideLayers(new Map(row(20, 0)), 8);
  assert.equal(widestRow(wrapped.values()), 7);
  assert.equal(new Set([...wrapped.values()].map((position) => position.y)).size, 3);
});

test("wrapped nodes never overlap", () => {
  const wrapped = [...wrapWideLayers(new Map(row(20, 0)), 8).values()];
  for (let i = 0; i < wrapped.length; i++) {
    for (let j = i + 1; j < wrapped.length; j++) {
      const a = wrapped[i];
      const b = wrapped[j];
      if (a === undefined || b === undefined) continue;
      const overlaps = Math.abs(a.x - b.x) < nodeWidth && Math.abs(a.y - b.y) < nodeHeight;
      assert.equal(overlaps, false, `nodes ${i} and ${j} overlap`);
    }
  }
});

test("a layer at or under the cap keeps its ELK positions", () => {
  const original = row(8, 40);
  const wrapped = wrapWideLayers(new Map(original), 8);
  for (const [id, position] of original) assert.deepEqual(wrapped.get(id), position);
});

test("layers below a wrapped layer move down by the extra rows", () => {
  const positions = new Map([...row(20, 0), ["below", { x: 50, y: 200 }] as const]);
  const wrapped = wrapWideLayers(positions, 8);
  assert.equal(wrapped.get("below")?.y, 200 + 2 * (nodeHeight + 14));
});

test("the Modules layout keeps a 212-child root within the row cap", async () => {
  const blocks = [
    displayBlock("root"),
    ...Array.from({ length: 212 }, (_, index) => displayBlock(`c${index}`)),
  ];
  const connections = Array.from({ length: 212 }, (_, index) => ({
    id: `e${index}`,
    source: "root",
    target: `c${index}`,
    kind: "contains" as const,
  }));
  const { nodes } = await layoutBlocks({ blocks, connections });
  const widest = widestRow(nodes.map((node) => node.position));
  assert.ok(widest <= maxNodesPerRow, `widest row holds ${widest} nodes`);
});

function displayBlock(id: string): DisplayBlock {
  return {
    id,
    label: id,
    type: "module",
    parentId: null,
    children: [],
    sourcePath: null,
    fingerprint: id,
    description: "",
    annotationKind: "MODULE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  } as unknown as DisplayBlock;
}
