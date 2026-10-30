import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StateChartView, loadStateChartState, type StateChartViewState } from "./StateChartFeature.js";
import { detectStateChart, layoutStateChart } from "./state-chart.js";

function render(state: StateChartViewState): string {
  return renderToStaticMarkup(createElement(StateChartView, { state, onClose() {} }));
}

test("state chart view explains selection, loading, empty, and error states", () => {
  assert.match(render({ kind: "select" }), /Select a source-backed block/);
  assert.match(render({ kind: "loading", label: "Session" }), /Reading Session/);
  assert.match(render({ kind: "empty", path: "src/plain.ts" }), /No explicit state transitions/);
  assert.match(render({ kind: "error", message: "permission denied" }), /permission denied/);
});

test("state chart view renders regions, orthogonal edges, source lines, and state kinds", () => {
  const chart = detectStateChart({
    path: "src/job.rs",
    content: `enum Job { #[default] Queued, Running, Done }
fn next(value: Job) -> Job { match value {
  Job::Queued => Job::Running,
  Job::Running => Job::Done,
} }`,
  });
  const html = render({ kind: "ready", path: chart.sourcePath, chart, layout: layoutStateChart(chart) });

  assert.match(html, /aria-label="State chart for src\/job.rs"/);
  assert.match(html, /class="state-chart-region"/);
  assert.match(html, /class="state-chart-edge"/);
  assert.match(html, /Queued/);
  assert.match(html, /initial state/);
  assert.match(html, /terminal state/);
  assert.match(html, /line 1/);
  assert.match(html, /STATE CHART/);
});

test("state chart view reports bounded evidence", () => {
  const variants = Array.from({ length: 125 }, (_, index) => `S${index}`);
  const arms = Array.from({ length: 124 }, (_, index) => `Big::S${index} => Big::S${index + 1},`);
  const chart = detectStateChart({
    path: "src/big.rs",
    content: `enum Big { ${variants.join(",")} }\nfn next(value: Big) -> Big { match value { ${arms.join("\n")} Big::S124 => Big::S124, } }`,
  });
  const html = render({ kind: "ready", path: chart.sourcePath, chart, layout: layoutStateChart(chart) });

  assert.match(html, /5 states and 6 transitions omitted/);
  assert.match(html, /bounded result/);
});

test("state chart loader returns ready and empty results from the editor boundary", async () => {
  const ready = await loadStateChartState({
    async inspectBlock(workspaceId, blockId) {
      assert.equal(workspaceId, "workspace");
      assert.equal(blockId, "block");
      return {
        path: "src/mode.ts",
        content: "enum Mode { A, B } switch (mode) { case Mode.A: return Mode.B; }",
        line: 1,
        column: 1,
      };
    },
  }, "workspace", "block");
  assert.equal(ready.kind, "ready");

  const empty = await loadStateChartState({
    async inspectBlock() {
      return { path: "src/plain.ts", content: "const value = 1;", line: 1, column: 1 };
    },
  }, "workspace", "block");
  assert.deepEqual(empty, { kind: "empty", path: "src/plain.ts" });
});

test("state chart loader describes Error, string, object, and unknown failures", async () => {
  for (const [failure, message] of [
    [new Error("offline"), "offline"],
    ["not found", "not found"],
    [{ message: "denied" }, "denied"],
    [null, "Could not load the selected source file."],
  ] as const) {
    const state = await loadStateChartState({
      async inspectBlock() { throw failure; },
    }, "workspace", "block");
    assert.deepEqual(state, { kind: "error", message });
  }
});
