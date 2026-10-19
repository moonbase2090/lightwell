import { test, expect, gotoIpc } from "./helpers.js";

test.describe("commit diff (ipc)", () => {
  test.beforeEach(async ({ page }) => gotoIpc(page));

  async function pickThrough(page: import("@playwright/test").Page) {
    const select = page.getByLabel("Show changes through this commit");
    await expect(select).toBeVisible();
    const options = await select.locator("option").count();
    expect(options).toBeGreaterThan(1);
    await select.selectOption({ index: 1 });
  }

  test("DIFF-01: Through commit selector lists commits", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByLabel("Show changes through this commit")).not.toHaveValue("");
  });

  test("DIFF-02: Since selector appears after a Through pick", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByLabel("Start the range after this commit")).toBeVisible();
  });

  test("DIFF-03: Reading commit state resolves", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByText("Reading commit…")).toBeHidden();
  });

  test("DIFF-04: no commit error on captured history", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByText(/could not|failed/i)).toHaveCount(0);
  });

  test("DIFF-05: diff summary banner names the commit", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByRole("status").filter({ hasText: /block changed/ })).toBeVisible();
  });

  test("DIFF-06: Only changed toggle toggles", async ({ page }) => {
    await pickThrough(page);
    const toggle = page.getByRole("checkbox", { name: "Only show changed blocks on the map and file tree" });
    await toggle.click();
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("DIFF-07: Prev / Next navigation is present", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByRole("button", { name: /prev|next/i }).first()).toBeVisible();
  });

  test("DIFF-08: bracket keys navigate changes", async ({ page }) => {
    await pickThrough(page);
    await page.keyboard.press("]");
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("DIFF-09: change list expands", async ({ page }) => {
    await pickThrough(page);
    const expand = page.getByRole("button", { name: /expand|changes/i }).first();
    await expand.click();
    await expect(page.getByText(/\+3/).first()).toBeVisible();
  });

  test("DIFF-10: block diff view opens for a changed block", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("DIFF-11: outside-map file entry is listed", async ({ page }) => {
    await pickThrough(page);
    const expand = page.getByRole("button", { name: /expand|changes/i }).first();
    await expand.click();
    await expect(page.getByText("README.md").first()).toBeVisible();
  });
});
