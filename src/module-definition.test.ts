import assert from "node:assert/strict";
import test from "node:test";
import { resolveSourceDefinition } from "./module-definition.js";
import type { DisplayBlock } from "./model.js";

function block(id: string, label: string, type: DisplayBlock["type"] = "module"): DisplayBlock {
  return {
    id,
    label,
    type,
    parentId: null,
    children: [],
    sourcePath: `src/${label}.rs`,
    fingerprint: "fp",
    packageName: "pkg",
    modulePath: label,
    declaredByPath: "src/lib.rs",
  } as unknown as DisplayBlock;
}

test("a word naming exactly one module resolves to that module", () => {
  const blocks = [block("m:diff", "diff"), block("m:notes", "notes")];
  assert.deepEqual(resolveSourceDefinition("notes", blocks, "m:diff", []), { kind: "block", blockId: "m:notes" });
});

test("a word naming several modules is ambiguous", () => {
  const blocks = [block("a:util", "util"), block("b:util", "util")];
  assert.equal(resolveSourceDefinition("util", blocks, null, []), null);
});

test("the inspected module is not its own definition", () => {
  const blocks = [block("m:diff", "diff")];
  assert.equal(resolveSourceDefinition("diff", blocks, "m:diff", []), null);
});

test("crates and unknown words do not resolve", () => {
  const blocks = [block("c:diff", "diff", "crate"), block("m:notes", "notes")];
  assert.equal(resolveSourceDefinition("diff", blocks, null, []), null);
  assert.equal(resolveSourceDefinition("missing", blocks, null, []), null);
  assert.equal(resolveSourceDefinition("", blocks, null, []), null);
});

test("a symbol resolves inside the current file and overrides its own outline entry", () => {
  const blocks = [block("file", "helpers"), { ...block("symbol", "calculate"), sourcePath: "src/helpers.rs" }];
  const definition = { name: "calculate", blockId: "file", line: 12, column: 8 };
  assert.deepEqual(resolveSourceDefinition("calculate", blocks, "file", [definition]), { kind: "definition", definition: { name: "calculate", blockId: "file", line: 12, column: 8 } });
});

test("duplicate symbols, overloads, and a module in another file stay ambiguous", () => {
  const blocks = [block("a", "helpers"), block("b", "calculate")];
  const first = { name: "calculate", blockId: "a", line: 12, column: 8 };
  assert.equal(resolveSourceDefinition("calculate", blocks, null, [first]), null);
  assert.equal(resolveSourceDefinition("calculate", blocks, null, [first, { ...first, line: 30 }]), null);
  assert.equal(resolveSourceDefinition("calculate", blocks, null, [first, { ...first, blockId: "b" }]), null);
});
