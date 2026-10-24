import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README tells agents to git add notes.json after notes set", () => {
  assert.match(
    readme,
    /`lightwell notes set` writes `\.lightwell\/notes\.json` but does not stage or commit it/,
  );
  assert.match(readme, /git add \.lightwell\/notes\.json/);
  assert.match(
    readme,
    /The notes CLI does not run `git add` or `git commit`/,
  );
});
