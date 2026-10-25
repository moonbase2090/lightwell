import assert from "node:assert/strict";
import test from "node:test";
import { registerSwiftHighlighter } from "./languages/highlighters/swift.js";

function mockMonaco(registered: ReadonlyArray<{ id: string }>) {
  let registerCalls = 0;
  let providerCalls = 0;
  let providerLanguage: string | undefined;
  const languages = registered.map((language) => ({ ...language }));
  const monaco = {
    languages: {
      getLanguages: () => languages,
      register: (language: { id: string }) => {
        registerCalls += 1;
        languages.push({ id: language.id });
      },
      setMonarchTokensProvider: (languageId: string) => {
        providerCalls += 1;
        providerLanguage = languageId;
      },
    },
  };
  return {
    monaco,
    counts: () => ({ registerCalls, providerCalls, providerLanguage }),
  };
}

test("swift highlighter registers Monarch provider on first call", () => {
  const { monaco, counts } = mockMonaco([]);
  registerSwiftHighlighter(monaco as never);
  assert.deepEqual(counts(), { registerCalls: 1, providerCalls: 1, providerLanguage: "swift" });
});

test("swift highlighter skips register when swift is already present", () => {
  const { monaco, counts } = mockMonaco([{ id: "swift" }]);
  registerSwiftHighlighter(monaco as never);
  assert.deepEqual(counts(), { registerCalls: 0, providerCalls: 0, providerLanguage: undefined });
});
