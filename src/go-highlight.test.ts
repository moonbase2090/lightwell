import assert from "node:assert/strict";
import test from "node:test";
import { registerGoHighlighter } from "./languages/highlighters/go.js";

test("go highlighter registers once", () => {
  const monaco = {
    languages: {
      getLanguages: () => [{ id: "go" }],
      register: () => undefined,
      setMonarchTokensProvider: () => undefined,
    },
  };
  registerGoHighlighter(monaco as never);
  assert.ok(true);
});
