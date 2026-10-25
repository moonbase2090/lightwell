import assert from "node:assert/strict";
import test from "node:test";
import { registerRubyHighlighter } from "./languages/highlighters/ruby.js";

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

test("ruby highlighter registers Monarch provider on first call", () => {
  const { monaco, counts } = mockMonaco([]);
  registerRubyHighlighter(monaco as never);
  assert.deepEqual(counts(), { registerCalls: 1, providerCalls: 1, providerLanguage: "ruby" });
});

test("ruby highlighter skips register when ruby is already present", () => {
  const { monaco, counts } = mockMonaco([{ id: "ruby" }]);
  registerRubyHighlighter(monaco as never);
  assert.deepEqual(counts(), { registerCalls: 0, providerCalls: 0, providerLanguage: undefined });
});
