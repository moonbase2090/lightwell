import { test, expect, gotoWeb, gotoIpc } from "./helpers.js";

test.describe("map canvas (web)", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page));

  test("MAP-01: Modules / Files toggle switches the view", async ({ page }) => {
    const group = page.getByRole("group", { name: "Map view" }).first();
    await group.getByRole("button", { name: "Files" }).click();
    await expect(page.getByRole("tree", { name: "File tree" })).toBeVisible();
    await group.getByRole("button", { name: "Modules" }).click();
    await expect(page.getByRole("tree", { name: "File tree" })).toBeHidden();
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

  test("MAP-15: compound dependency chart follows its feature flag", async ({ page }) => {
    const enabled = process.env.VITE_ENABLE_COMPOUND_LAYOUT === "true";
    await expect(page.getByLabel("Dependency chart legend")).toHaveCount(enabled ? 1 : 0);
    const compoundGroups = page.locator(".react-flow__node-compoundGroup");
    if (enabled) await expect(compoundGroups.first()).toBeVisible();
    else await expect(compoundGroups).toHaveCount(0);
    await expect(page.locator(".react-flow__node-codeBlock").first()).toBeVisible();
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
    const node = page.locator(".react-flow__node").first();
    const groupHeader = node.locator(".compound-group-header");
    if (await groupHeader.count() > 0) await groupHeader.click();
    else await node.click();
    await page.keyboard.press("n");
    await page.getByLabel("Project note text").fill("map badge note");
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Escape");
    // Saving the note marks the node: its note badge renders. Without the
    // add-note flow the badge count stays zero.
    await expect(page.locator(".node-note-badge").first()).toBeVisible();
  });
});
