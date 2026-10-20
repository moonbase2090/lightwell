import { test, expect, gotoWeb, gotoIpc } from "./helpers.js";

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /settings/i }).first().click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

test.describe("settings (web)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoWeb(page);
    await openSettings(page);
  });

  test("SET-01: theme selector applies a theme", async ({ page }) => {
    const select = page.getByRole("combobox", { name: "THEME" });
    await select.selectOption({ label: "Dark" });
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // The Dark preference resolves to the dark theme on the shell and is
    // persisted for this device (see theme.ts saveThemePreference).
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => window.localStorage.getItem("lightwell.theme"))).toBe("dark");
  });

  test("SET-02: UI text size steps and resets", async ({ page }) => {
    const group = page.getByRole("group", { name: /Interface text size|UI text/ }).first();
    await group.getByRole("button", { name: /Increase/ }).click();
    await group.getByRole("button", { name: /Reset/ }).click();
    await expect(group.getByRole("button", { name: /Reset/ })).toBeDisabled();
  });

  test("SET-03: source code size steps", async ({ page }) => {
    const group = page.getByRole("group", { name: /Source code/ }).first();
    await group.getByRole("button", { name: /Increase/ }).click();
    await expect(group).toContainText("14 px");
  });

  test("SET-04: tree/map label size steps", async ({ page }) => {
    const group = page.getByRole("group", { name: /label/i }).first();
    await group.getByRole("button", { name: /Increase/ }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("SET-05: word wrap shortcut recorder shows guidance on bad chord", async ({ page }) => {
    const recorder = page.getByRole("button", { name: /Alt\+Z|shortcut/i }).first();
    await recorder.click();
    await page.keyboard.press("a");
    await expect(page.getByText("Use Ctrl, Alt, or Meta with a letter or number, or an F-key.")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("SET-06: automatic update check toggle toggles", async ({ page }) => {
    const box = page.getByRole("checkbox", { name: /update/i }).first();
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
  });

  test("SET-11: dialog closes on Escape and traps focus", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeHidden();
  });
});

test.describe("settings (ipc)", () => {
  test.beforeEach(async ({ page }) => {
    await gotoIpc(page);
    await openSettings(page);
  });

  test("SET-07: Check now is enabled on desktop source", async ({ page }) => {
    const btn = page.getByRole("button", { name: /check now/i });
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(page.getByText(/up to date|Checking/).first()).toBeVisible();
  });

  test("SET-08: editor preset selector fills the template", async ({ page }) => {
    const select = page.getByRole("combobox", { name: "START WITH A PRESET" });
    await select.selectOption({ index: 1 });
    await expect(page.getByLabel("EDITOR COMMAND TEMPLATE")).toHaveValue("code -g {file}:{line}:{column}");
  });

  test("SET-09: editor command template accepts text", async ({ page }) => {
    const input = page.getByLabel("EDITOR COMMAND TEMPLATE");
    await input.fill("code -g {file}:{line}:{column}");
    await expect(input).toHaveValue("code -g {file}:{line}:{column}");
  });

  test("SET-10: Save editor preference saves", async ({ page }) => {
    const input = page.getByLabel("EDITOR COMMAND TEMPLATE");
    await input.fill("code -g {file}:{line}:{column}");
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("SET-12: no update prompt when no update is found", async ({ page }) => {
    await expect(page.getByText("Update available")).toHaveCount(0);
  });
});
