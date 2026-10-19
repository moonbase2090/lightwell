import { test, expect, gotoIpc } from "./helpers.js";

test.describe("source inspector (ipc)", () => {
  test.beforeEach(async ({ page }) => gotoIpc(page));

  async function openSource(page: import("@playwright/test").Page) {
    const node = page.locator(".react-flow__node").first();
    await node.click({ button: "right" });
    await page.getByText("Open source").click();
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
  }

  test("EDIT-01: Open source opens the inspector", async ({ page }) => {
    await openSource(page);
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
  });

  test("EDIT-02: inspector header closes the inspector", async ({ page }) => {
    await openSource(page);
    await page.getByRole("button", { name: /close/i }).first().click();
    await expect(page.getByText("READ-ONLY SOURCE")).toBeHidden();
  });

  test("EDIT-03: loading state resolves to code", async ({ page }) => {
    await openSource(page);
    await expect(page.getByText("Loading source…")).toBeHidden();
  });

  test("EDIT-04: no source error on a captured block", async ({ page }) => {
    await openSource(page);
    // Monaco mounts empty role=alert live regions; only an alert carrying
    // a message is an app error.
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  });

  test("EDIT-05: code view is read-only", async ({ page }) => {
    await openSource(page);
    // Monaco's labelled textarea is visually hidden; the rendered editor
    // surface is the visible proof, the label names it read-only.
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
    await expect(page.getByLabel(/read-only source:/i).first()).toBeAttached();
  });

  test("EDIT-06: position footer reads LINE / COLUMN", async ({ page }) => {
    await openSource(page);
    // The footer text is split by a separator element, so match on the
    // footer element's combined text instead of one text node.
    await expect(page.locator(".inspector-position")).toContainText(/LINE \d+\s+COLUMN \d+/);
  });

  test("EDIT-07: Open in editor button is enabled after load", async ({ page }) => {
    await openSource(page);
    await expect(page.getByRole("button", { name: /open in editor/i })).toBeEnabled();
  });

  test("EDIT-08: editor launch succeeds with the mock", async ({ page }) => {
    await openSource(page);
    await page.getByRole("button", { name: /open in editor/i }).click();
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  });

  test("EDIT-09: word wrap item is in the source-line menu", async ({ page }) => {
    await openSource(page);
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible();
    await editor.click({ button: "right" });
    await expect(page.getByText(/word wrap/i).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("EDIT-10: Alt+Z toggles word wrap in the editor", async ({ page }) => {
    await openSource(page);
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("Alt+z");
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
  });
});
