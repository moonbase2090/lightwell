import { test, expect, gotoIpc } from "./helpers.js";

test("state chart labels guards and arranges a cycle from top to bottom", async ({ page }, testInfo) => {
  const phase = {
    path: "src/phase.ts", line: 1, column: 1,
    content: `enum Phase { Start, Active, Done }
function next(phase: Phase, event: string): Phase {
  switch (phase) {
    case Phase.Start: if (event === "begin") return Phase.Active; return Phase.Start;
    case Phase.Active: if (event === "finish") return Phase.Done; return Phase.Active;
    case Phase.Done: return Phase.Start;
  }
}`,
  };
  // A click on a card drills into it, so every block the test can select reads the same file.
  await gotoIpc(page, { sources: {
    "workspace:prismattyc": phase,
    "crate:web-sample": phase,
    "app:web-sample:main": phase,
    "module:web-sample:main": phase,
  } });
  await page.locator(".react-flow__node-codeBlock").first().click();
  await page.getByRole("button", { name: "States", exact: true }).click();
  const chart = page.getByRole("img", { name: "State chart for src/phase.ts" });
  await expect(chart).toBeVisible();
  await expect(chart.locator(".state-chart-edge-label")).toContainText(["begin", "transition", "finish", "transition", "transition"]);
  const ys = await chart.locator(".state-chart-node rect").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("y"))));
  expect(ys).toHaveLength(3);
  expect(ys[0]).toBeLessThan(ys[1] ?? 0);
  expect(ys[1]).toBeLessThan(ys[2] ?? 0);
  await page.screenshot({ path: testInfo.outputPath("state-flow.png") });
  await page.getByRole("button", { name: "Back to map" }).click();
  await expect(chart).toHaveCount(0);
  await expect(page.locator(".react-flow__node-codeBlock").first()).toBeVisible();
});
