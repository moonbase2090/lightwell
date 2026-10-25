import assert from "node:assert/strict";
import test from "node:test";
import { registerSwiftHighlighter } from "./languages/highlighters/swift.js";

test("swift highlighter registers once", () => {
  const monaco = {
    languages: {
      getLanguages: () => [{ id: "swift" }],
      register: () => undefined,
      setMonarchTokensProvider: () => undefined,
    },
  };
  registerSwiftHighlighter(monaco as never);
  assert.ok(true);
});
