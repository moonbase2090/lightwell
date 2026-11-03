import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepoText } from "./test-tools.js";

const text = readRepoText(new URL("../.github/workflows/links.yml", import.meta.url));
const packageLinksAction =
  "moonbase2090/.github/actions/package-links@0f192a5bb8fa198ab154fb4f721bdd8ca0813946";

test("release preparation defers asset probes until publication", () => {
  assert.match(
    text,
    /- name: Check links while release assets are pending\n        if: github\.event_name == 'push' \|\| startsWith\(github\.head_ref, 'release\/'\)/,
  );
  assert.match(
    text,
    /link-excludes:.*\^https:\/\/github\\\.com\/moonbase2090\/lightwell\/releases\/download\/v\[0-9\]\+/s,
  );
  assert.match(
    text,
    /- name: Check all links\n        if: github\.event_name != 'push' && !startsWith\(github\.head_ref, 'release\/'\)/,
  );
  assert.equal(text.split(packageLinksAction).length - 1, 2);
});
