import { test, expect, gotoWeb, gotoIpc } from "./helpers.js";

async function openFiles(page: import("@playwright/test").Page) {
  await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Files" }).click();
  await expect(page.getByRole("tree", { name: "File tree" })).toBeVisible();
}

test.describe("file tree (web)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoWeb(page);
    await openFiles(page);
  });

  test("TREE-01: filter input keeps matching rows", async ({ page }) => {
    await page.getByPlaceholder("Filter symbols...").fill("main");
    await expect(page.getByRole("tree", { name: "File tree" })).toContainText("main");
  });

  test("TREE-02: tree copy of the view toggle is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Modules" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Files" }).first()).toBeVisible();
  });

  test("TREE-03: Expand all shows nested rows", async ({ page }) => {
    await page.getByRole("button", { name: /expand all/i }).click();
    const rows = await page.getByRole("treeitem").count();
    expect(rows).toBeGreaterThan(1);
  });

  test("TREE-04: Collapse leaves only the root row", async ({ page }) => {
    await page.getByRole("button", { name: /expand all/i }).click();
    await page.getByRole("button", { name: /^collapse$/i }).click();
    await expect(page.getByRole("treeitem")).toHaveCount(1);
  });

  test("TREE-05: zoom buttons step and reset the scale", async ({ page }) => {
    const zoom = page.getByRole("group", { name: "File tree zoom" });
    await zoom.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom.getByRole("button", { name: "Reset file tree zoom" })).toContainText("110%");
    await zoom.getByRole("button", { name: "Reset file tree zoom" }).click();
    await expect(zoom.getByRole("button", { name: "Reset file tree zoom" })).toContainText("100%");
  });

  test("TREE-06: Ctrl+= zooms in and Ctrl+0 resets", async ({ page }) => {
    await page.keyboard.press("Control+=");
    const zoom = page.getByRole("group", { name: "File tree zoom" });
    await expect(zoom.getByRole("button", { name: "Reset file tree zoom" })).toContainText("110%");
    await page.keyboard.press("Control+0");
    await expect(zoom.getByRole("button", { name: "Reset file tree zoom" })).toContainText("100%");
  });

  test("TREE-07: depth control (tree copy) changes value", async ({ page }) => {
    const depth = page.getByLabel("Map depth").last();
    await depth.selectOption("1");
    await expect(depth).toHaveValue("1");
  });

  test("TREE-08: row count reads N of M nodes", async ({ page }) => {
    await expect(page.getByText(/of \d+ nodes/)).toBeVisible();
  });

  test("TREE-09: clicking a row selects it", async ({ page }) => {
    const row = page.getByRole("treeitem").nth(1);
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
  });

  test("TREE-10: chevron toggles a folder without selecting", async ({ page }) => {
    const toggle = page.getByRole("button", { name: /Expand|Collapse/ }).first();
    const before = await toggle.getAttribute("aria-label");
    await toggle.click();
    await expect(toggle).not.toHaveAttribute("aria-label", before ?? "");
  });

  test("TREE-11: empty filter state", async ({ page }) => {
    await page.getByPlaceholder("Filter symbols...").fill("zzz-no-match-zzz");
    await expect(page.getByText("No matching symbols")).toBeVisible();
  });

  test("TREE-12: rows show kind badges", async ({ page }) => {
    await expect(page.getByRole("treeitem").first()).toContainText(/FILE|APP|MOD|FEAT/);
  });
});

test.describe("file tree (ipc)", () => {
  test("TREE-13: tree renders under the mocked source", async ({ page }) => {
    await gotoIpc(page);
    await openFiles(page);
    await expect(page.getByRole("treeitem").first()).toBeVisible();
  });
});
