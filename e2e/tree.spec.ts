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

  test("TREE-14: selecting a file row opens its source by default", async ({ page }) => {
    await gotoIpc(page);
    await openFiles(page);
    await page.getByRole("button", { name: /expand all/i }).click();
    const fileRow = page.getByRole("treeitem").filter({ hasText: /\.mjs/ }).first();
    await fileRow.click();
    await expect(page.getByLabel(/Source inspector for/)).toBeVisible();
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
  });

  test("TREE-15: arrow keys move focus without opening, Enter opens", async ({ page }) => {
    await gotoIpc(page);
    await openFiles(page);
    await page.getByRole("button", { name: /expand all/i }).click();
    const rows = page.getByRole("treeitem");
    const fileRow = rows.filter({ hasText: /\.mjs/ }).first();
    const rowTexts = await rows.allTextContents();
    const fileIndex = rowTexts.findIndex((text) => /\.mjs/.test(text));
    expect(fileIndex).toBeGreaterThanOrEqual(0);
    expect(fileIndex + 1).toBeLessThan(rowTexts.length);
    const selectedBefore = await page.locator('[role="treeitem"][aria-selected="true"]').textContent();
    await fileRow.focus();
    await expect(fileRow).toBeFocused();
    // ArrowDown must move focus to the NEXT visible row — this fails if the
    // key handler is a no-op — without selecting it or opening its source.
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(fileIndex + 1)).toBeFocused();
    await expect(page.getByLabel(/Source inspector for/)).toHaveCount(0);
    await expect(fileRow).toHaveAttribute("aria-selected", /^(false)?$/);
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveText(selectedBefore ?? "");
    // ArrowUp returns focus to the file row, still without opening source.
    await page.keyboard.press("ArrowUp");
    await expect(fileRow).toBeFocused();
    await expect(rows.nth(fileIndex + 1)).not.toBeFocused();
    await expect(page.getByLabel(/Source inspector for/)).toHaveCount(0);
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveText(selectedBefore ?? "");
    // Enter commits the selection, which opens the source by default.
    await page.keyboard.press("Enter");
    await expect(page.getByLabel(/Source inspector for/)).toBeVisible();
  });

  test("SET-13: show-details-first keeps the inspector one click from source", async ({ page }) => {
    await gotoIpc(page);
    await page.getByRole("button", { name: /settings/i }).first().click();
    await page.getByLabel(/selecting a file or symbol/i).selectOption("show-details");
    await page.keyboard.press("Escape");
    await openFiles(page);
    await page.getByRole("button", { name: /expand all/i }).click();
    const fileRow = page.getByRole("treeitem").filter({ hasText: /\.mjs/ }).first();
    await fileRow.click();
    // Details first: the tree inspector shows and no source is open yet.
    await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await expect(page.getByLabel(/Source inspector for/)).toHaveCount(0);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByLabel(/Source inspector for/)).toBeVisible();
    // The choice survives a reload: selecting again still shows details.
    await page.reload();
    await openFiles(page);
    await page.getByRole("button", { name: /expand all/i }).click();
    await page.getByRole("treeitem").filter({ hasText: /\.mjs/ }).first().click();
    await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await expect(page.getByLabel(/Source inspector for/)).toHaveCount(0);
  });
});
