import { test, expect, gotoWeb, gotoIpc } from "./helpers.js";

test.describe("map canvas (web)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoWeb(page);
  });

  test("MAP-01: Atlas / Modules / Files toggle switches the view", async ({ page }) => {
    const group = page.getByRole("group", { name: "Map view" }).first();
    await group.getByRole("button", { name: "Files" }).click();
    await expect(page.getByRole("tree", { name: "File tree" })).toBeVisible();
    await group.getByRole("button", { name: "Modules" }).click();
    await expect(page.getByRole("tree", { name: "File tree" })).toBeHidden();
    await group.getByRole("button", { name: "Atlas" }).click();
    await expect(page.getByRole("tree", { name: "Workspace atlas outline" })).toBeVisible();
  });

  test("MAP-02: depth control changes the depth value", async ({ page }) => {
    const depth = page.getByLabel("Map depth").first();
    await depth.selectOption("1");
    await expect(depth).toHaveValue("1");
  });

  test("MAP-03: direct children count is displayed", async ({ page }) => {
    await expect(page.getByText(/direct children/)).toBeVisible();
  });

  test("MAP-04: breadcrumbs show the workspace root", async ({ page }) => {
    await expect(page.getByLabel("Map breadcrumbs")).toContainText("Prismattyc");
  });

  test("MAP-05: rotate tree button appears in Files view", async ({ page }) => {
    await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Files" }).click();
    await expect(page.getByRole("button", { name: /Rotate file tree/ })).toBeVisible();
  });

  test("MAP-06: connection legend shows contains / depends on", async ({ page }) => {
    await expect(page.getByText(/contains/).first()).toBeVisible();
  });

  test("MAP-08: hovering a node keeps the canvas visible", async ({ page }) => {
    const node = page.locator(".react-flow__node").first();
    await node.hover();
    await expect(node).toBeVisible();
  });

  test("MAP-10: canvas controls are present", async ({ page }) => {
    await expect(page.locator(".react-flow__controls")).toBeVisible();
  });

  test("MAP-11: graph finishes preparing", async ({ page }) => {
    await expect(page.getByText("Preparing graph layout…")).toBeHidden();
  });

  test("MAP-12: feature group tabs are listed", async ({ page }) => {
    await expect(page.getByRole("tablist", { name: "Feature groups" })).toBeVisible();
  });

  test("MAP-13: feature cards show FEATURE entries", async ({ page }) => {
    await expect(page.getByText("FEATURE").first()).toBeVisible();
  });

  test("MAP-14: clicking a feature card selects the group", async ({ page }) => {
    const card = page.locator(".feature-card").first();
    // No card starts selected; the inspector shows block details.
    await expect(page.locator(".feature-card.chosen")).toHaveCount(0);
    await expect(page.getByText("CONNECTED BLOCKS")).toHaveCount(0);
    await card.click();
    // The click marks the card chosen and the inspector switches to the
    // feature-group details. A dead click handler changes neither.
    await expect(card).toHaveClass(/chosen/);
    await expect(page.getByText("CONNECTED BLOCKS")).toBeVisible();
  });

  test("MAP-15: compound dependency chart is on by default and opts out with false", async ({ page }) => {
    // Only an exact VITE_ENABLE_COMPOUND_LAYOUT=false build turns the chart off.
    const enabled = process.env.VITE_ENABLE_COMPOUND_LAYOUT !== "false";
    await expect(page.getByLabel("Dependency chart legend")).toHaveCount(enabled ? 1 : 0);
    const compoundGroups = page.locator(".react-flow__node-compoundGroup");
    if (enabled) await expect(compoundGroups.first()).toBeVisible();
    else await expect(compoundGroups).toHaveCount(0);
    await expect(page.locator(".react-flow__node-codeBlock").first()).toBeVisible();
  });

  test("MAP-16: the first fit shows the root below the canvas header at a readable zoom", async ({ page }) => {
    // Prismattyc's 68-child root layer wraps into rows. The fit must keep the root card
    // clear of the floating header and large enough to read: fitting the root with a
    // stacked column of children shrank it under 0.3x and slid it beneath the header.
    const root = page.locator('.react-flow__node[data-id="workspace:prismattyc"]');
    const header = page.locator(".canvas-watermark");
    await expect(root).toBeVisible();
    // Measure only once the animated fit has settled; the first frames show zoom 1.
    const viewport = page.locator(".react-flow__viewport");
    const transform = () => viewport.evaluate((element) => getComputedStyle(element).transform);
    await expect.poll(async () => {
      const before = await transform();
      await page.waitForTimeout(400);
      return before !== "none" && before !== "matrix(1, 0, 0, 1, 0, 0)" && before === (await transform());
    }).toBe(true);
    await expect.poll(async () => {
      const [rootBox, headerBox] = await Promise.all([root.boundingBox(), header.boundingBox()]);
      if (rootBox === null || headerBox === null) return "not rendered";
      if (rootBox.y < headerBox.y + headerBox.height) return `root top ${rootBox.y} under header bottom ${headerBox.y + headerBox.height}`;
      if (rootBox.width < 222 * 0.3) return `root ${rootBox.width}px wide`;
      return "ok";
    }).toBe("ok");
  });
});

test.describe("map canvas (ipc)", () => {
  test("MAP-07: graph node shows label and selects on click", async ({ page }) => {
    await gotoIpc(page);
    // No source inspector is open before the click selects a node.
    await expect(page.getByLabel(/Source inspector for/)).toHaveCount(0);
    const node = page.locator(".react-flow__node").first();
    await expect(node).toBeVisible();
    const groupHeader = node.locator(".compound-group-header");
    if (await groupHeader.count() > 0) await groupHeader.click();
    else await node.click();
    // The click selects the workspace root block and opens its inspector.
    // A dead click handler opens nothing, so neither state holds pre-action.
    await expect(page.getByLabel("Source inspector for Prismattyc")).toBeVisible();
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
  });

  test("MAP-09: note badge appears on the node after adding a note", async ({ page }) => {
    await gotoIpc(page);
    // No notes exist yet, so no badge is rendered.
    await expect(page.locator(".node-note-badge")).toHaveCount(0);
    await page.getByRole("button", { name: /Add note/ }).click();
    await page.getByLabel("Project note text").fill("map badge note");
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Escape");
    // Saving the note marks the node: its note badge renders. Without the
    // add-note flow the badge count stays zero.
    await expect(page.locator(".node-note-badge").first()).toBeVisible();
  });
});

test.describe("workspace atlas", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page, "atlas"));

  test("MAP-17: atlas is the default and keeps dependency edges hidden at rest", async ({ page }) => {
    const group = page.getByRole("group", { name: "Map view" }).first();
    await expect(group.getByRole("button", { name: "Atlas" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("tree", { name: "Workspace atlas outline" })).toBeVisible();
    await expect.poll(() => page.locator(".atlas-cell").count()).toBeGreaterThanOrEqual(400);
    await expect(page.locator(".atlas-edges path")).toHaveCount(0);
  });

  test("MAP-18: search selects a block and opens its focused dependency lens", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("prismattyc-host");
    const result = page.getByRole("treeitem", { name: /prismattyc-host/i }).last();
    await expect(result).toBeVisible();
    await result.click();
    await expect(result).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: /Dependencies for prismattyc-host/i })).toBeVisible();
    await expect(page.locator(".atlas-edges path").first()).toBeVisible();
    const selectedCell = page.locator(".atlas-cell.is-selected");
    await selectedCell.dblclick();
    await expect(selectedCell.locator("text")).toHaveText("prismattyc-host");
    await page.getByLabel("Filter workspace atlas").fill("");
    await expect(page.getByRole("treeitem", { name: /prismattyc-host/i }).last()).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("Filter workspace atlas").fill("session_prompt");
    await page.getByRole("treeitem", { name: /session_prompt/i }).last().click();
    await expect(page.getByRole("button", { name: "Fit workspace" })).toBeEnabled();
    await expect(page.locator(".atlas-cell.is-selected")).toBeVisible();
    await expect(page.locator(".atlas-cell.is-selected text")).not.toHaveText("");
  });

  test("MAP-20: selecting a module keeps the map readable and counts the parent link", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("config_template");
    const row = page.getByRole("treeitem", { name: /config_template/i }).last();
    await expect(row).toBeVisible();
    await row.click();
    const selected = page.locator(".atlas-cell.is-selected");
    await expect(selected).toBeVisible();
    await expect(selected.locator("text")).not.toHaveText("");
    const dimmed = page.locator(".atlas-cell.is-dimmed");
    const dimmedCount = await dimmed.count();
    const cellCount = await page.locator(".atlas-cell").count();
    expect(dimmedCount).toBeGreaterThan(0);
    expect(dimmedCount).toBeLessThan(cellCount - 1);
    const opacity = await dimmed.first().evaluate((element) => Number(getComputedStyle(element).opacity));
    expect(opacity).toBeGreaterThanOrEqual(0.55);
    expect(opacity).toBeLessThanOrEqual(0.75);
    const lens = page.getByRole("region", { name: /Dependencies for config_template/i });
    await expect(lens).toContainText("No depends-on links");
    await expect(lens).toContainText("1 incoming");
    await expect(lens.getByRole("button", { name: /contains/i })).toBeVisible();
    const svgBox = await page.getByRole("img", { name: "Workspace treemap" }).boundingBox();
    const cellBox = await selected.locator("rect.atlas-cell-shape").boundingBox();
    expect(svgBox).not.toBeNull();
    expect(cellBox).not.toBeNull();
    expect(cellBox!.width).toBeGreaterThan(svgBox!.width * 0.08);
  });

  test("MAP-21: overview labels stay inside their cells and follow the label setting", async ({ page }) => {
    await expect.poll(() => page.locator(".atlas-cell text").count()).toBeGreaterThan(24);
    const overflow = await page.evaluate(() => {
      const cells = [...document.querySelectorAll(".atlas-cell")];
      return cells.filter((cell) => {
        const text = cell.querySelector("text");
        const rect = cell.querySelector("rect.atlas-cell-shape");
        if (text === null || rect === null) return false;
        const textBox = text.getBoundingClientRect();
        const cellBox = rect.getBoundingClientRect();
        if (textBox.width === 0) return false;
        return textBox.left < cellBox.left - 1 || textBox.right > cellBox.right + 1 || textBox.bottom > cellBox.bottom + 1;
      }).length;
    });
    expect(overflow).toBe(0);
    const coversTiles = await page.evaluate(() => {
      const bar = document.querySelector(".atlas-canvas-actions")?.getBoundingClientRect();
      const svg = document.querySelector(".atlas-canvas svg[aria-label='Workspace treemap']")?.getBoundingClientRect();
      if (bar === undefined || svg === undefined) return true;
      return bar.bottom > svg.top + 1 && bar.top < svg.bottom;
    });
    expect(coversTiles).toBe(false);
    const before = await page.locator(".atlas-cell text").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    await page.getByRole("button", { name: /settings/i }).first().click();
    await page.getByRole("button", { name: "Increase Tree and map labels" }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect.poll(async () => page.locator(".atlas-cell text").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(before);
  });

  test("MAP-22: search frames matches and clearing restores the atlas", async ({ page }) => {
    const svg = page.getByRole("img", { name: "Workspace treemap" });
    await expect.poll(() => page.locator(".atlas-cell").count()).toBeGreaterThan(100);
    const initial = await svg.getAttribute("viewBox");
    await page.getByLabel("Filter workspace atlas").fill("config_template");
    await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(initial);
    await expect(page.locator(".atlas-cell.is-match").first()).toBeVisible();
    await page.getByLabel("Filter workspace atlas").fill("zzzz-not-a-module");
    await expect(page.locator(".atlas-canvas-note")).toHaveText("No matching blocks");
    await page.getByLabel("Clear atlas filter").click();
    await expect(page.locator(".atlas-canvas-note")).toHaveCount(0);
    await expect.poll(() => svg.getAttribute("viewBox")).toBe(initial);
    await expect(page.locator(".atlas-cell.is-match")).toHaveCount(0);
  });

  test("MAP-23: wheel zoom and a region fit survive selecting a cell", async ({ page }) => {
    const svg = page.getByRole("img", { name: "Workspace treemap" });
    await expect.poll(() => page.locator(".atlas-cell").count()).toBeGreaterThan(100);
    const initial = await svg.getAttribute("viewBox");
    await svg.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    });
    await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(initial);
    const zoomed = await svg.getAttribute("viewBox");
    await page.locator(".atlas-cell").nth(8).click({ force: true });
    await expect.poll(() => svg.getAttribute("viewBox")).toBe(zoomed);
    await page.getByRole("button", { name: "Fit workspace" }).click();
    await expect.poll(() => svg.getAttribute("viewBox")).toBe(initial);
    const region = page.locator(".atlas-cell.depth-2").first();
    await region.dblclick({ force: true });
    await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(initial);
    const fitted = await svg.getAttribute("viewBox");
    await region.click({ force: true });
    await expect.poll(() => svg.getAttribute("viewBox")).toBe(fitted);
  });

  test("MAP-24: the atlas legend matches the workspace connection total", async ({ page }) => {
    const summary = page.locator(".overview-stat", { hasText: "connections" });
    await expect(summary).toBeVisible();
    const total = Number((await summary.innerText()).match(/(\d+)/)?.[1]);
    const contains = Number((await page.locator(".legend-item").nth(0).innerText()).match(/(\d+)/)?.[1]);
    const depends = Number((await page.locator(".legend-item").nth(1).innerText()).match(/(\d+)/)?.[1]);
    expect(contains).toBeGreaterThan(0);
    expect(depends).toBeGreaterThan(0);
    expect(contains + depends).toBe(total);
  });

  test("MAP-25: modules lays out after the dev double-mount", async ({ page }) => {
    await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Modules" }).click();
    await expect(page.getByText("Compound layout client was disposed")).toHaveCount(0);
    await expect.poll(() => page.locator(".react-flow__node").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("MAP-19: commit changes highlight atlas regions and filter the outline", async ({ page }) => {
    await gotoIpc(page, {}, "atlas");
    await page.getByLabel("Show changes", { exact: true }).selectOption("lastCommit");
    await expect(page.locator(".atlas-cell.is-changed").first()).toBeVisible();
    await expect(page.locator(".atlas-outline-change").first()).toBeVisible();
    const mixedChange = page.locator(".atlas-cell.is-changed.has-additions.has-removals:not(.is-selected)").first();
    await expect(mixedChange).toBeVisible();
    await page.getByRole("button", { name: /settings/i }).first().click();
    await page.getByRole("combobox", { name: "THEME" }).selectOption("light");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(mixedChange.locator("rect.atlas-cell-shape")).toHaveCSS("stroke", "rgb(155, 98, 28)");
    const toggle = page.getByRole("checkbox", { name: "Only show changed blocks on the map and file tree" });
    await toggle.click();
    await expect(page.locator(".atlas-cell.is-filtered").first()).toBeVisible();
    const changedBlock = page.getByRole("treeitem", { name: /main/i });
    await expect(changedBlock).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /Scorecard/i })).toHaveCount(0);
    await toggle.click();
    await page.getByRole("button", { name: "Expand change list" }).click();
    await page.getByRole("button", { name: /File README\.md/ }).click();
    await expect(page.getByLabel("Source inspector for README.md")).toBeVisible();
    await page.getByLabel("Filter workspace atlas").fill("src/main.mjs");
    const leaf = page.getByRole("treeitem", { name: /main.*MODULE/i }).last();
    await leaf.click();
    await expect(page.getByLabel("Source inspector for README.md")).toHaveCount(0);
    await leaf.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
    await page.keyboard.press("Escape");
    await leaf.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Open source" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open source" }).click();
    await expect(page.getByLabel("Source inspector for main")).toBeVisible();
  });
});
