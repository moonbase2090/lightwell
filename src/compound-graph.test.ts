import assert from "node:assert/strict";
import test from "node:test";
import type { DisplayBlock, FactConnection } from "./model.js";
import {
  buildCompoundGraph,
  buildCompoundLayoutInput,
  orthogonalEdgeGeometry,
} from "./viewer/compound-graph.js";
import type { CompoundLayoutResult } from "./viewer/compound-layout.js";

function workspace(id: string, children: readonly string[]): DisplayBlock {
  return {
    id,
    label: "Demo",
    type: "workspace",
    parentId: null,
    children,
    sourcePath: null,
    fingerprint: "workspace-fingerprint",
    memberCount: children.length,
    description: "Demo workspace",
    annotationKind: "MODULE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

function crate(id: string, parentId: string, children: readonly string[]): DisplayBlock {
  return {
    id,
    label: "Core",
    type: "crate",
    parentId,
    children,
    sourcePath: "crates/core/Cargo.toml",
    fingerprint: "crate-fingerprint",
    packageName: "core",
    version: "0.1.0",
    description: "Core crate",
    annotationKind: "CRATE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

function app(id: string, parentId: string): DisplayBlock {
  return {
    id,
    label: "CLI",
    type: "app",
    parentId,
    children: [],
    sourcePath: "crates/core/src/main.rs",
    fingerprint: "app-fingerprint",
    packageName: "core",
    targetName: "cli",
    entryPath: "crates/core/src/main.rs",
    targetKind: "bin",
    description: "Command-line entry point",
    annotationKind: "APP",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

function moduleBlock(id: string, parentId: string): DisplayBlock {
  return {
    id,
    label: "Model",
    type: "module",
    parentId,
    children: [],
    sourcePath: "crates/core/src/model.rs",
    fingerprint: "module-fingerprint",
    packageName: "core",
    modulePath: "core::model",
    declaredByPath: "crates/core/src/lib.rs",
    cfgAttributes: [],
    unresolved: false,
    description: "Domain model",
    annotationKind: "MODULE",
    status: "ready",
    annotationState: "current",
    virtual: false,
  };
}

const blocks = [
  workspace("workspace:demo", ["crate:core"]),
  crate("crate:core", "workspace:demo", ["app:cli", "module:model"]),
  app("app:cli", "crate:core"),
  moduleBlock("module:model", "crate:core"),
];

const connections: FactConnection[] = [
  { id: "contains-workspace-core", source: "workspace:demo", target: "crate:core", kind: "contains" },
  { id: "contains-core-cli", source: "crate:core", target: "app:cli", kind: "contains" },
  { id: "cli-model", source: "app:cli", target: "module:model", kind: "depends_on", dependencyScope: "normal" },
  { id: "outside", source: "app:other", target: "module:model", kind: "depends_on", dependencyScope: "normal" },
];

const result: CompoundLayoutResult = {
  nodes: [
    {
      kind: "block",
      id: "workspace:demo",
      parentId: null,
      blockType: "workspace",
      hiddenDescendants: 0,
      bounds: { x: 0, y: 0, width: 540, height: 360 },
    },
    {
      kind: "block",
      id: "crate:core",
      parentId: "workspace:demo",
      blockType: "crate",
      hiddenDescendants: 3,
      bounds: { x: 16, y: 44, width: 508, height: 300 },
    },
    {
      kind: "block",
      id: "app:cli",
      parentId: "crate:core",
      blockType: "app",
      hiddenDescendants: 0,
      bounds: { x: 32, y: 88, width: 222, height: 94 },
    },
    {
      kind: "block",
      id: "module:model",
      parentId: "crate:core",
      blockType: "module",
      hiddenDescendants: 0,
      bounds: { x: 286, y: 210, width: 222, height: 94 },
    },
    {
      kind: "summary",
      id: "layout-summary:crate%3Acore",
      parentId: "crate:core",
      hiddenDescendants: 17,
      bounds: { x: 32, y: 220, width: 180, height: 64 },
    },
  ],
  edges: [
    {
      id: "depends:crate:core:app:cli:module:model",
      groupId: "crate:core",
      source: "app:cli",
      target: "module:model",
      sourceEdgeIds: ["cli-model"],
      label: "depends on",
      points: [
        { x: 143, y: 182 },
        { x: 143, y: 196 },
        { x: 397, y: 196 },
        { x: 397, y: 210 },
      ],
    },
  ],
  stats: {
    inputBlocks: 21,
    renderedBlocks: 5,
    omittedBlocks: 17,
    inputEdges: 1,
    renderedEdges: 1,
    omittedEdges: 0,
    cacheHits: 0,
    cacheMisses: 2,
    cacheEntries: 2,
  },
};

test("compound layout input contains only visible dependency facts", () => {
  const input = buildCompoundLayoutInput({
    rootId: "workspace:demo",
    blocks,
    connections,
  });

  assert.deepEqual(input.blocks.map((block) => block.id), [
    "workspace:demo",
    "crate:core",
    "app:cli",
    "module:model",
  ]);
  assert.deepEqual(input.connections, [{ id: "cli-model", source: "app:cli", target: "module:model" }]);
  assert.deepEqual(input.limits, { maxBlocks: 800, maxEdges: 1_600 });
});

test("compound graph keeps nested coordinates relative and worker routes absolute", () => {
  const graph = buildCompoundGraph({
    rootId: "workspace:demo",
    blocks,
    layout: result,
    labelScale: 1,
  });
  assert.deepEqual(graph.nodes.map((node) => [node.id, node.type]), [
    ["workspace:demo", "compoundGroup"],
    ["crate:core", "compoundGroup"],
    ["app:cli", "codeBlock"],
    ["module:model", "codeBlock"],
    ["layout-summary:crate%3Acore", "compoundSummary"],
  ]);

  const root = graph.nodes[0];
  const core = graph.nodes[1];
  const cli = graph.nodes[2];
  assert.deepEqual(root?.position, { x: 0, y: 0 });
  assert.equal(root?.parentId, undefined);
  assert.deepEqual(core?.position, { x: 16, y: 44 });
  assert.equal(core?.parentId, "workspace:demo");
  assert.deepEqual(cli?.position, { x: 16, y: 44 });
  assert.equal(cli?.parentId, "crate:core");

  if (core?.type !== "compoundGroup") assert.fail("core should render as a compound group");
  assert.equal(core.data.hiddenDescendants, 3);
  const summary = graph.nodes[4];
  if (summary?.type !== "compoundSummary") assert.fail("summary should render as a compound summary");
  assert.equal(summary.data.hiddenDescendants, 17);
  assert.equal(summary.data.block.id, "crate:core");

  const edge = graph.edges[0];
  assert.equal(edge?.type, "orthogonal");
  assert.deepEqual(edge?.data?.points, result.edges[0]?.points);
  assert.deepEqual(edge?.data?.labelPosition, { x: 270, y: 196 });
});

test("orthogonal edge geometry omits a label when no horizontal segment fits", () => {
  assert.deepEqual(orthogonalEdgeGeometry({
    points: [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }],
    label: "depends on",
    labelScale: 1,
  }), {
    path: "M 0 0 L 0 20 L 30 20",
    labelPosition: null,
  });
});
