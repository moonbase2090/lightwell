import { test, expect, gotoIpc } from "./helpers.js";

// Selecting one block and then another must replace the read-only source:
// the inspector follows the selection instead of keeping the first file.
test.describe("source inspector follows the selection (ipc)", () => {
  test.beforeEach(async ({ page }) => gotoIpc(page));

  test("SRC-01: selecting block A then block B changes the source", async ({ page }) => {
    const nodes = page.locator(".react-flow__node");
    const editor = page.locator(".source-code-editor");
    const label = editor.locator("[aria-label^=\"Read-only source: \"]").first();

    await nodes.nth(0).click({ button: "right" });
    await page.getByText("Open source").click();
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
    await expect(label).toHaveAttribute("aria-label", /^Read-only source: /);
    const firstLabel = (await label.getAttribute("aria-label")) ?? "";
    const firstText = await editor.locator(".view-lines").first().innerText();

    const count = await nodes.count();
    let changed = false;
    for (let index = 1; index < count && !changed; index += 1) {
      await nodes.nth(index).click();
      const nextLabel = await label.getAttribute("aria-label").catch(() => null);
      if (nextLabel !== null && nextLabel !== firstLabel) changed = true;
    }
    expect(changed).toBe(true);
    await expect(label).not.toHaveAttribute("aria-label", firstLabel);
    await expect(editor.locator(".view-lines").first()).not.toHaveText(firstText);
    // Exactly one editor is mounted: the first one was replaced, not left behind.
    await expect(page.locator(".source-code-editor .monaco-editor")).toHaveCount(1);
  });
});

test.describe("source inspector after a file diff (ipc)", () => {
  test.beforeEach(async ({ page }) => gotoIpc(page));

  test("SRC-02: selecting a block after a changed-file diff shows the block", async ({ page }) => {
    const select = page.getByLabel("Show changes", { exact: true });
    await expect(select).toBeVisible();
    await select.selectOption("lastCommit");
    await page.getByRole("button", { name: /expand|changes/i }).first().click();
    await page.getByRole("button", { name: /README\.md/ }).first().click();
    await expect(page.getByLabel("Source inspector for README.md")).toBeVisible();

    const search = page.getByPlaceholder("Search blocks and features…");
    await search.fill("main");
    await expect(page.getByLabel("Map search results")).toContainText("main");
    await page.keyboard.press("Enter");

    await expect(page.getByLabel("Source inspector for README.md")).toHaveCount(0);
    await expect(page.locator("[aria-label^=\"Source inspector for \"]")).toHaveCount(1);
    await expect(page.locator("[aria-label^=\"Source inspector for \"]")).not.toHaveAttribute("aria-label", "Source inspector for README.md");
  });
});
