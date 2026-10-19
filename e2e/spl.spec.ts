import { test, expect, gotoWeb } from "./helpers.js";

test.describe("splitters (web)", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page));

  test("SPL-01: map/source splitter handle is present", async ({ page }) => {
    await expect(page.getByRole("separator").first()).toBeVisible();
  });

  test("SPL-02: map/features splitter handle is present", async ({ page }) => {
    await expect(page.getByRole("separator")).toHaveCount(2);
  });

  test("SPL-03: keyboard resize moves the handle 24px", async ({ page }) => {
    const handle = page.getByRole("separator", { name: "Resize map and source panel" });
    await handle.focus();
    const before = await handle.getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowLeft");
    const after = await handle.getAttribute("aria-valuenow");
    expect(Number(after)).toBe(Number(before) - 24);
  });

  test("SPL-03b: Shift+Arrow moves the handle 6px", async ({ page }) => {
    const handle = page.getByRole("separator", { name: "Resize map and source panel" });
    await handle.focus();
    const before = await handle.getAttribute("aria-valuenow");
    await page.keyboard.press("Shift+ArrowRight");
    const after = await handle.getAttribute("aria-valuenow");
    expect(Number(after)).toBe(Number(before) + 6);
  });

  test("SPL-04: double-click resets the splitter", async ({ page }) => {
    const handle = page.getByRole("separator", { name: "Resize map and source panel" });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await handle.dblclick();
    await expect(handle).toHaveAttribute("aria-valuetext", /pixels/);
  });

  test("SPL-05: splitter size persists across reload", async ({ page }) => {
    const handle = page.getByRole("separator", { name: "Resize map and source panel" });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    const value = await handle.getAttribute("aria-valuenow");
    await page.reload();
    await expect(page.getByRole("separator", { name: "Resize map and source panel" })).toHaveAttribute("aria-valuenow", value ?? "");
  });
});
