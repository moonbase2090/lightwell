import assert from "node:assert/strict";
import test from "node:test";
import { registerCppHighlighter } from "./languages/highlighters/cpp.js";

test("cpp highlighter registers language and Monarch once when missing", () => {
  let registerCalls = 0;
  let monarchCalls = 0;
  const monaco = {
    languages: {
      getLanguages: () => [],
      register: () => {
        registerCalls += 1;
      },
      setMonarchTokensProvider: () => {
        monarchCalls += 1;
      },
    },
  };
  registerCppHighlighter(monaco as never);
  assert.equal(registerCalls, 1);
  assert.equal(monarchCalls, 1);
});

test("cpp highlighter skips register when already registered", () => {
  let registerCalls = 0;
  let monarchCalls = 0;
  const monaco = {
    languages: {
      getLanguages: () => [{ id: "cpp" }],
      register: () => {
        registerCalls += 1;
      },
      setMonarchTokensProvider: () => {
        monarchCalls += 1;
      },
    },
  };
  registerCppHighlighter(monaco as never);
  assert.equal(registerCalls, 0);
  assert.equal(monarchCalls, 0);
});
