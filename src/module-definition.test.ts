import assert from "node:assert/strict";
import test from "node:test";
import { resolveModuleDefinition } from "./module-definition.js";
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
  assert.equal(resolveModuleDefinition("notes", blocks, "m:diff")?.id, "m:notes");
});

test("a word naming several modules is ambiguous", () => {
  const blocks = [block("a:util", "util"), block("b:util", "util")];
  assert.equal(resolveModuleDefinition("util", blocks, null), null);
});

test("the inspected module is not its own definition", () => {
  const blocks = [block("m:diff", "diff")];
  assert.equal(resolveModuleDefinition("diff", blocks, "m:diff"), null);
});

test("crates and unknown words do not resolve", () => {
  const blocks = [block("c:diff", "diff", "crate"), block("m:notes", "notes")];
  assert.equal(resolveModuleDefinition("diff", blocks, null), null);
  assert.equal(resolveModuleDefinition("missing", blocks, null), null);
  assert.equal(resolveModuleDefinition("", blocks, null), null);
});
