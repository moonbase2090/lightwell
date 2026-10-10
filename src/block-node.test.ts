import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { DisplayBlock } from "./model.js";
import BlockNode, { type BlockNodeData, type MapNode } from "./viewer/BlockNode.js";

function moduleBlock(): DisplayBlock {
  return {
    id: "module:parser",
    label: "parser",
    type: "module",
    parentId: "crate:core",
    children: ["module:lexer"],
    sourcePath: "crates/lightwell-core/src/parser.rs",
    fingerprint: "fp",
    packageName: "lightwell-core",
    modulePath: "parser",
    declaredByPath: "src/lib.rs",
    cfgAttributes: [],
    unresolved: false,
    description: "Parses maps",
    annotationKind: "MODULE",
    status: "wip",
    annotationState: "changed",
    virtual: false,
  };
}

function retiredCrate(): DisplayBlock {
  return {
    id: "crate:old",
    label: "old-crate",
    type: "crate",
    parentId: null,
    children: [],
    sourcePath: null,
    fingerprint: "fp",
    packageName: "old-crate",
    version: "0.1.0",
    description: "Retired crate",
    annotationKind: "CRATE",
    status: "deprecated",
    annotationState: "current",
    virtual: false,
  };
}

function renderBlock(data: BlockNodeData, selected = false): string {
  const props: NodeProps<MapNode> = {
    id: data.block.id,
    data,
    type: "codeBlock",
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: false,
    selected,
    draggable: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  const view: ReactElement = createElement(
    ReactFlowProvider,
    null,
    createElement(BlockNode, props),
  );
  return renderToStaticMarkup(view);
}

test("map node shows kind, status, shortened path, child count, and a changed annotation", () => {
  const block = moduleBlock();
  const html = renderBlock({
    block,
    dimmed: true,
    highlighted: false,
    onHover: () => undefined,
  }, true);

  assert.match(html, /class="block-node node-module status-wip selected dimmed annotation-changed"/);
  assert.match(html, /title="Parses maps"/);
  assert.match(html, /<span class="node-kind">MODULE<\/span>/);
  assert.match(html, /<span class="status-pill status-wip">wip<\/span>/);
  assert.match(html, /<span class="node-name">parser<\/span>/);
  assert.match(html, /<span class="node-path">src\/parser\.rs<\/span>/);
  assert.match(html, /<span class="node-children"><span>1<\/span>/);
  assert.match(html, /class="lucide lucide-circle-alert[^"]* node-alert"/);
});

test("map node names an unresolved source and hides child and change chrome", () => {
  const block = retiredCrate();
  const html = renderBlock({
    block,
    dimmed: false,
    highlighted: true,
    onHover: () => undefined,
  });

  assert.match(html, /class="block-node node-crate status-deprecated highlighted"/);
  assert.match(html, /<span class="status-pill status-deprecated">deprecated<\/span>/);
  assert.match(html, /<span class="node-path">source path unresolved<\/span>/);
  assert.equal(html.includes("node-children"), false);
  assert.equal(html.includes("annotation-changed"), false);
  assert.equal(html.includes("node-alert"), false);
  assert.equal(html.includes(" selected"), false);
});
