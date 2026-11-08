import assert from "node:assert/strict";
import test from "node:test";
import { sourceTargetRange } from "./source-target.js";

test("source target range selects the declaration from its requested column", () => {
  assert.deepEqual(sourceTargetRange({
    content: "first\nexport function parse() {}\nlast",
    line: 2,
    column: 1,
  }), {
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 2,
    endColumn: 27,
  });
});

test("source target range clamps stale positions to the loaded document", () => {
  assert.deepEqual(sourceTargetRange({
    content: "first\r\nlast",
    line: 99,
    column: 99,
  }), {
    startLineNumber: 2,
    startColumn: 5,
    endLineNumber: 2,
    endColumn: 5,
  });
});
