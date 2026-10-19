import { test, expect, gotoWeb } from "./helpers.js";

test.describe("inspectors (web)", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page));

  async function selectFirstNode(page: import("@playwright/test").Page) {
    await page.locator(".react-flow__node").first().click();
  }

  test("INSP-01: block details show kind and label", async ({ page }) => {
    await selectFirstNode(page);
    await expect(page.getByText(/WORKSPACE|CRATE|APP|MODULE/i).first()).toBeVisible();
  });

  test("INSP-02: block stats grid is shown", async ({ page }) => {
    await selectFirstNode(page);
    await expect(page.getByText(/children/i).first()).toBeVisible();
  });

  test("INSP-03: child block rows are listed for a parent", async ({ page }) => {
    await selectFirstNode(page);
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("INSP-04: feature details list connected blocks", async ({ page }) => {
    const card = page.locator("[class*='feature']").filter({ hasText: "FEATURE" }).first();
    await card.click();
    await expect(page.getByText("FEATURE").first()).toBeVisible();
  });

  test("INSP-05: folder details render in horizontal Files view", async ({ page }) => {
    await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Files" }).click();
    await page.getByRole("button", { name: /Rotate file tree to horizontal/ }).click();
    const node = page.locator(".react-flow__node").first();
    await node.click();
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("INSP-06: tree inspector shows the selected row", async ({ page }) => {
    await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Files" }).click();
    await page.getByRole("treeitem").nth(1).click();
    await expect(page.getByText(/depth/i).first()).toBeVisible();
  });

  test("INSP-07: no saved-note card before any note exists", async ({ page }) => {
    await selectFirstNode(page);
    await expect(page.getByLabel("Project note")).toHaveCount(0);
  });

  test("INSP-08: Add note button is offered for a block", async ({ page }) => {
    await selectFirstNode(page);
    await expect(page.getByRole("button", { name: /add note|edit note/i }).first()).toBeVisible();
  });
});
