import assert from "node:assert/strict";
import test from "node:test";
import { registerJvmHighlighters } from "./languages/highlighters/jvm.js";

test("jvm highlighter registers java and kotlin monarch grammars once", () => {
  const registered: string[] = [];
  const grammars = new Map<string, { keywords?: string[] }>();
  const monaco = {
    languages: {
      getLanguages: () => registered.map((id) => ({ id })),
      register: (language: { id: string }) => {
        registered.push(language.id);
      },
      setMonarchTokensProvider: (id: string, grammar: { keywords?: string[] }) => {
        grammars.set(id, grammar);
      },
    },
  };
  registerJvmHighlighters(monaco as never);
  registerJvmHighlighters(monaco as never);
  assert.deepEqual(registered, ["java", "kotlin"]);
  assert.ok(grammars.get("java")?.keywords?.includes("class"));
  assert.ok(grammars.get("kotlin")?.keywords?.includes("fun"));
  assert.ok(grammars.get("kotlin")?.keywords?.includes("object"));
});
