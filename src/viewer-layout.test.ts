import assert from "node:assert/strict";
import test from "node:test";
import type { Edge } from "@xyflow/react";
import type { DisplayBlock, FactConnection } from "./model.js";
import type { MapNode } from "./viewer/BlockNode.js";
import { emphasizeGraph, layoutBlocks } from "./viewer/layout.js";

function moduleBlock(id: string, label: string, sourcePath: string | null = null): DisplayBlock {
  return {
    id,
    label,
    type: "module",
    parentId: "crate:core",
    children: [],
    sourcePath,
    fingerprint: "fp",
    packageName: "lightwell-core",
    modulePath: label,
    declaredByPath: "src/lib.rs",
    cfgAttributes: [],
    unresolved: sourcePath === null,
    description: `${label} description`,
    annotationKind: "MODULE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

function crateBlock(id: string, label: string): DisplayBlock {
  return {
    id,
    label,
    type: "crate",
    parentId: null,
    children: [],
    sourcePath: null,
    fingerprint: "fp",
    packageName: label,
    version: "0.1.0",
    description: `${label} description`,
    annotationKind: "CRATE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

function mapNode(block: DisplayBlock): MapNode {
  return {
    id: block.id,
    type: "codeBlock",
    position: { x: 0, y: 0 },
    width: 222,
    height: 94,
    data: {
      block,
      dimmed: false,
      highlighted: false,
      onHover: () => undefined,
      onActivate: () => undefined,
    },
  };
}

function graphEdge(id: string, source: string, target: string): Edge {
  return { id, source, target, style: { stroke: "#000000", strokeWidth: 1, opacity: 1 } };
}

function markerColor(edge: Edge): string {
  const marker = edge.markerEnd;
  if (typeof marker !== "object" || marker === null || !("color" in marker) || typeof marker.color !== "string") {
    throw new Error("expected a colored arrow marker");
  }
  return marker.color;
}

test("layout drops connections whose ends are not on the map and styles the rest", async () => {
  const core = crateBlock("crate:core", "core");
  const parser = moduleBlock("module:parser", "parser");
  const connections: readonly FactConnection[] = [
    { id: "contains", source: "crate:core", target: "module:parser", kind: "contains" },
    { id: "depends", source: "module:parser", target: "crate:core", kind: "depends_on", dependencyScope: "normal" },
    { id: "hidden", source: "module:parser", target: "module:missing", kind: "contains" },
  ];

  const layout = await layoutBlocks({ blocks: [parser, core], connections });

  assert.deepEqual(layout.edges.map((edge) => edge.id), ["contains", "depends"]);
  const contains = layout.edges[0];
  const depends = layout.edges[1];
  assert.equal(contains?.label, undefined);
  assert.equal(contains?.type, "smoothstep");
  assert.deepEqual(contains?.style, { stroke: "#4d8df4", strokeWidth: 1.2, opacity: 0.34 });
  assert.equal(markerColor(contains!), "#4d8df4");
  assert.equal(depends?.label, "depends");
  assert.deepEqual(depends?.style, { stroke: "#59d8c0", strokeWidth: 1.2, opacity: 0.34 });
  assert.equal(markerColor(depends!), "#59d8c0");

  assert.deepEqual(layout.nodes.map((node) => [node.id, node.width, node.height]), [
    ["module:parser", 222, 94],
    ["crate:core", 222, 94],
  ]);
  const crateNode = layout.nodes.find((node) => node.id === "crate:core");
  const moduleNode = layout.nodes.find((node) => node.id === "module:parser");
  assert.ok(crateNode !== undefined && moduleNode !== undefined);
  assert.ok(crateNode.position.y < moduleNode.position.y);
  assert.equal(crateNode.data.dimmed, false);
  assert.equal(moduleNode.data.highlighted, false);
});

test("layout keeps an isolated block and returns nothing for an empty map", async () => {
  const alone = await layoutBlocks({
    blocks: [moduleBlock("module:alone", "alone")],
    connections: [{ id: "dangling", source: "module:alone", target: "module:gone", kind: "contains" }],
  });
  assert.deepEqual(alone.nodes.map((node) => node.id), ["module:alone"]);
  assert.deepEqual(alone.edges, []);

  const empty = await layoutBlocks({ blocks: [], connections: [] });
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
});

test("emphasis highlights a block and its direct neighbors and fades the rest", () => {
  const active = crateBlock("crate:active", "active");
  const neighbor = moduleBlock("module:neighbor", "neighbor");
  const outsider = moduleBlock("module:outsider", "outsider");
  const hovered: Array<string | null> = [];
  const graph = emphasizeGraph({
    nodes: [mapNode(active), mapNode(neighbor), mapNode(outsider)],
    edges: [
      graphEdge("near", "crate:active", "module:neighbor"),
      graphEdge("far", "module:neighbor", "module:outsider"),
    ],
    activeNodeId: "crate:active",
    activeFeatureMemberIds: null,
    onHover: (id) => { hovered.push(id); },
    onActivate: () => undefined,
  });

  assert.deepEqual(graph.nodes.map((node) => [node.id, node.data.highlighted, node.data.dimmed]), [
    ["crate:active", true, false],
    ["module:neighbor", true, false],
    ["module:outsider", false, true],
  ]);
  const near = graph.edges.find((edge) => edge.id === "near");
  const far = graph.edges.find((edge) => edge.id === "far");
  assert.equal(near?.animated, true);
  assert.deepEqual(near?.style, { stroke: "#4d8df4", strokeWidth: 1.8, opacity: 0.86 });
  assert.equal(far?.animated, false);
  assert.deepEqual(far?.style, { stroke: "#4d8df4", strokeWidth: 1, opacity: 0.09 });

  graph.nodes[0]?.data.onHover("crate:active");
  graph.nodes[1]?.data.onHover(null);
  assert.deepEqual(hovered, ["crate:active", null]);
});

test("emphasis uses the feature membership and paints crate-to-crate edges teal", () => {
  const left = crateBlock("crate:left", "left");
  const right = crateBlock("crate:right", "right");
  const outside = moduleBlock("module:outside", "outside");
  const graph = emphasizeGraph({
    nodes: [mapNode(left), mapNode(right), mapNode(outside)],
    edges: [
      graphEdge("pair", "crate:left", "crate:right"),
      graphEdge("exit", "crate:left", "module:outside"),
    ],
    activeNodeId: null,
    activeFeatureMemberIds: new Set(["crate:left", "crate:right"]),
    onHover: () => undefined,
    onActivate: () => undefined,
  });

  assert.deepEqual(graph.nodes.map((node) => [node.id, node.data.highlighted, node.data.dimmed]), [
    ["crate:left", true, false],
    ["crate:right", true, false],
    ["module:outside", false, true],
  ]);
  const pair = graph.edges.find((edge) => edge.id === "pair");
  const exit = graph.edges.find((edge) => edge.id === "exit");
  assert.equal(pair?.animated, true);
  assert.equal((pair?.style as { stroke?: string } | undefined)?.stroke, "#59d8c0");
  assert.equal((pair?.style as { opacity?: number } | undefined)?.opacity, 0.86);
  assert.equal(exit?.animated, false);
  assert.equal((exit?.style as { stroke?: string } | undefined)?.stroke, "#4d8df4");
  assert.equal((exit?.style as { opacity?: number } | undefined)?.opacity, 0.09);
});

test("emphasis leaves every block readable when nothing is selected", () => {
  const graph = emphasizeGraph({
    nodes: [mapNode(crateBlock("crate:core", "core"))],
    edges: [graphEdge("loop", "crate:core", "crate:core")],
    activeNodeId: null,
    activeFeatureMemberIds: null,
    onHover: () => undefined,
    onActivate: () => undefined,
  });

  assert.equal(graph.nodes[0]?.data.dimmed, false);
  assert.equal(graph.nodes[0]?.data.highlighted, false);
  assert.equal(graph.edges[0]?.animated, false);
  assert.equal((graph.edges[0]?.style as { opacity?: number } | undefined)?.opacity, 0.86);
  assert.equal((graph.edges[0]?.style as { strokeWidth?: number } | undefined)?.strokeWidth, 1.8);
});

test("a commit's changed blocks stay lit and carry their counts while the rest dims", () => {
  const changed = moduleBlock("module:changed", "changed");
  const quiet = moduleBlock("module:quiet", "quiet");
  const graph = emphasizeGraph({
    nodes: [mapNode(changed), mapNode(quiet)],
    edges: [],
    activeNodeId: null,
    activeFeatureMemberIds: null,
    onHover: () => undefined,
    onActivate: () => undefined,
    changes: new Map([["module:changed", { added: 2, removed: 1, direct: true }]]),
  });
  assert.deepEqual(graph.nodes.map((node) => [node.id, node.data.dimmed, node.data.change]), [
    ["module:changed", false, { added: 2, removed: 1, direct: true }],
    ["module:quiet", true, undefined],
  ]);
});
