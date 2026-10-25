import assert from "node:assert/strict";
import test from "node:test";
import { registerConfigInfraHighlighters } from "./languages/highlighters/config-infra.js";

test("config/infra highlighters register YAML, Terraform and Dockerfile grammars once", () => {
  const registered: string[] = [];
  const grammars = new Map<string, { readonly tokenizer?: unknown; readonly keywords?: readonly string[] }>();
  const monaco = {
    languages: {
      getLanguages: () => registered.map((id) => ({ id })),
      register: ({ id }: { readonly id: string }) => { registered.push(id); },
      setMonarchTokensProvider: (id: string, grammar: { readonly tokenizer?: unknown; readonly keywords?: readonly string[] }) => {
        grammars.set(id, grammar);
      },
    },
  };
  registerConfigInfraHighlighters(monaco as never);
  registerConfigInfraHighlighters(monaco as never);
  assert.deepEqual(registered, ["yaml", "terraform", "dockerfile"]);
  assert.ok(grammars.get("yaml")?.tokenizer);
  assert.ok(grammars.get("terraform")?.keywords?.includes("resource"));
  assert.ok(grammars.get("dockerfile")?.keywords?.includes("FROM"));
});
