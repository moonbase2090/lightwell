import { test, expect, gotoIpc } from "./helpers.js";

test.describe("language pack settings", () => {
  test("PACK-01: lists loaded and catalog packs, then installs from the catalog", async ({ page }) => {
    await gotoIpc(page);
    await page.getByRole("button", { name: /settings/i }).first().click();

    const loaded = page.getByLabel("Loaded language packs");
    await expect(loaded).toContainText("rust");
    await expect(loaded).toContainText("v1.0.0");
    await expect(loaded).toContainText(".rs, Cargo.toml");
    await expect(loaded).toContainText("Built in");

    const available = page.getByLabel("Available language packs");
    await expect(available).toContainText("demo");
    await expect(available).toContainText("Plain-text support for .demo files and DemoFile.");
    await available.getByRole("button", { name: "Install" }).click();

    await expect(available).toContainText("Installed");
    await expect(loaded).toContainText("demo");
    await expect(loaded).toContainText(".demo, DemoFile");
    await expect(loaded.getByRole("button", { name: "Uninstall demo" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as Record<string, unknown>).__LW_LANGUAGE_PACK_INSTALL_INPUT__
    ))).toEqual({
      source: { kind: "catalog", id: "demo" },
      replace: false,
      workspaceId: "workspace:prismattyc",
    });

    page.once("dialog", (dialog) => dialog.accept());
    await loaded.getByRole("button", { name: "Uninstall demo" }).click();
    await expect(loaded).not.toContainText("demo");
    await expect(available.getByRole("button", { name: "Install" })).toBeVisible();
  });
});
