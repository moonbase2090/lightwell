import { test, expect, gotoIpc } from "./helpers.js";

test("state chart labels guards and arranges a cycle from top to bottom", async ({ page }, testInfo) => {
  test.skip(process.env.VITE_ENABLE_STATE_CHART !== "true", "Requires the state-chart build flag");
  await gotoIpc(page, { sources: {
    "workspace:prismattyc": {
      path: "src/phase.ts", line: 1, column: 1,
      content: `enum Phase { Start, Active, Done }
function next(phase: Phase, event: string): Phase {
  switch (phase) {
    case Phase.Start: if (event === "begin") return Phase.Active; return Phase.Start;
    case Phase.Active: if (event === "finish") return Phase.Done; return Phase.Active;
    case Phase.Done: return Phase.Start;
  }
}`,
    },
  } });
  await page.locator(".react-flow__node").first().click();
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
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});
