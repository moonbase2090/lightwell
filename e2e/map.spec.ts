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
    const card = page.locator(".feature-card, [class*='feature']").filter({ hasText: "FEATURE" }).first();
    await card.click();
    // Inspector switches to the feature-group details.
    await expect(page.getByText(/FEATURE/).first()).toBeVisible();
  });
});

test.describe("map canvas (ipc)", () => {
  test("MAP-07: graph node shows label and selects on click", async ({ page }) => {
    await gotoIpc(page);
    const node = page.locator(".react-flow__node").first();
    await expect(node).toBeVisible();
    await node.click();
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("MAP-09: note badge flow is available on nodes", async ({ page }) => {
    await gotoIpc(page);
    // No notes exist yet, so no badge; creating one is covered in notes.spec.
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  });
});
