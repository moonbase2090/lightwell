import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CommitRangePicker from "./CommitRangePicker.js";
import type { MapHistorySource } from "./map-source.js";

const history: MapHistorySource = {
  resolveRange: () => Promise.reject(new Error("not used while rendering")),
  listCommits: () => Promise.resolve([]),
  listSinceCommits: () => Promise.resolve([]),
  commitChanges: () => Promise.reject(new Error("not used while rendering")),
  blockDiff: () => Promise.reject(new Error("not used while rendering")),
  fileDiff: () => Promise.reject(new Error("not used while rendering")),
};

function render(trailing?: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(CommitRangePicker, {
    history, workspaceId: "w", commits: [], loading: false, error: null, onResolved: () => undefined,
    ...(trailing === undefined ? {} : { trailing }),
  }));
}

test("the Show changes row carries the map view toolbar at its right end", () => {
  const html = render(createElement("span", { className: "toolbar-probe" }, "toolbar"));
  const row = html.indexOf('class="commit-picker"');
  const select = html.indexOf('aria-label="Show changes"');
  const trailing = html.indexOf('class="commit-picker-trailing"');
  const probe = html.indexOf("toolbar-probe");
  assert.ok(row >= 0 && select > row && trailing > select && probe > trailing);
  assert.equal(html.endsWith("</div></div>"), true);
});

test("the Show changes row has no trailing slot when it is given no toolbar", () => {
  assert.equal(render().includes("commit-picker-trailing"), false);
});
