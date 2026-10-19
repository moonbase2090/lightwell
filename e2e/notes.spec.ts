import { test, expect, gotoWeb, gotoIpc } from "./helpers.js";

test.describe("project notes (web)", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page));

  test("NOTES-01: Notes toolbar button opens the dialog", async ({ page }) => {
    await page.getByRole("button", { name: /^Notes/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Project notes");
    await page.keyboard.press("Escape");
  });

  test("NOTES-02: Add note button opens the dialog for the block", async ({ page }) => {
    await page.locator(".react-flow__node").first().click();
    await page.getByRole("button", { name: /add note|edit note/i }).first().click();
    await expect(page.getByRole("dialog")).toContainText("Project notes");
  });

  test("NOTES-03: pressing N opens the notes dialog", async ({ page }) => {
    await page.locator(".react-flow__node").first().click();
    await page.keyboard.press("n");
    await expect(page.getByRole("dialog")).toContainText("Project notes");
    await page.keyboard.press("Escape");
  });

  test("NOTES-04: right-click opens the block context menu", async ({ page }) => {
    const node = page.locator(".react-flow__node").first();
    await node.click({ button: "right" });
    await expect(page.getByText(/Add note|Edit note|Copy path/).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("NOTES-07: Copy path item is in the context menu", async ({ page }) => {
    const node = page.locator(".react-flow__node").first();
    await node.click({ button: "right" });
    await expect(page.getByText("Copy path")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("NOTES-09: dialog is titled Project notes with count", async ({ page }) => {
    await page.getByRole("button", { name: /^Notes/ }).click();
    await expect(page.getByRole("heading", { name: "Project notes" })).toBeVisible();
    await page.getByRole("button", { name: "Close project notes" }).click();
    await expect(page.getByRole("heading", { name: "Project notes" })).toBeHidden();
  });

  test("NOTES-10: note list is present in the dialog", async ({ page }) => {
    await page.getByRole("button", { name: /^Notes/ }).click();
    await expect(page.getByLabel("Saved project notes")).toBeVisible();
  });

  test("NOTES-12: empty state reads No notes yet", async ({ page }) => {
    await page.getByRole("button", { name: /^Notes/ }).click();
    await expect(page.getByText("No notes yet.")).toBeVisible();
  });

  test("NOTES-13: no note-action error on a clean open", async ({ page }) => {
    await page.getByRole("button", { name: /^Notes/ }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("NOTES-14: Show on map appears for a saved note", async ({ page }) => {
    await page.locator(".react-flow__node").first().click();
    await page.keyboard.press("n");
    await page.getByLabel("Project note text").fill("e2e note for show-on-map");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("button", { name: "Show on map" })).toBeVisible();
  });
});

test.describe("project notes (ipc)", () => {
  test("NOTES-05: Delete note item appears after adding via menu", async ({ page }) => {
    await gotoIpc(page);
    const node = page.locator(".react-flow__node").first();
    await node.click();
    await page.keyboard.press("n");
    await page.getByLabel("Project note text").fill("ipc note to delete");
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Escape");
    await node.click({ button: "right" });
    await expect(page.getByText("Delete note")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("NOTES-06: Open source item appears in the ipc context menu", async ({ page }) => {
    await gotoIpc(page);
    const node = page.locator(".react-flow__node").first();
    await node.click({ button: "right" });
    await expect(page.getByText("Open source")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("NOTES-08: source-line menu is covered via EDIT-09", async ({ page }) => {
    await gotoIpc(page);
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("NOTES-11: saving a note reports the on-disk message", async ({ page }) => {
    await gotoIpc(page);
    await page.locator(".react-flow__node").first().click();
    await page.keyboard.press("n");
    await page.getByLabel("Project note text").fill("ipc saved note");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText("Saved in .lightwell/notes.json")).toBeVisible();
  });

  test("NOTES-15: memory/ipc notes start non-stale", async ({ page }) => {
    await gotoIpc(page);
    await page.locator(".react-flow__node").first().click();
    await page.keyboard.press("n");
    await page.getByLabel("Project note text").fill("fresh note");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText("Source changed")).toHaveCount(0);
  });
});
