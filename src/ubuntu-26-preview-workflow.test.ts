import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepoText } from "./test-tools.js";

const text = readRepoText(new URL("../.github/workflows/ubuntu-26-preview.yml", import.meta.url));

test("preview upload-artifact steps are pinned to a full commit SHA", () => {
  assert.equal(text.includes("actions/upload-artifact@v"), false);
  const uploads = [...text.matchAll(/^ {2,}(?:- )?uses: (actions\/upload-artifact@\S+)/gm)].map(
    (match) => match[1],
  );
  assert.ok(uploads.length > 0);
  for (const action of uploads) {
    assert.match(action, /^actions\/upload-artifact@[0-9a-f]{40}$/, `Pin ${action} to a commit`);
  }
  assert.match(
    text,
    /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/,
  );
});
