import { test, expect, gotoIpc } from "./helpers.js";

test("deleted symbol opens its historical diff without a current-map block", async ({ page }) => {
  const commit = { id: "swap", shortId: "swap", summary: "Swap", timestamp: 1 };
  await gotoIpc(page, {
    changes: {
      baseCommit: null, commit,
      files: [{ path: "scripts/job.py", oldPath: null, added: 2, removed: 2, binary: false }],
      blocks: [
        { blockId: "module:python:scripts-job-added:def", label: "added", sourcePath: "scripts/job.py", parentId: "module:python:scripts-job", state: "added", added: 2, removed: 0 },
        { blockId: "module:python:scripts-job-retired:def", label: "retired", sourcePath: "scripts/job.py", parentId: "module:python:scripts-job", state: "removed", added: 0, removed: 2 },
      ],
      connections: [],
    },
    diff: {
      commit, path: "scripts/job.py", originalPath: null,
      original: "def keep():\n    return 1\ndef retired():\n    return 3\n",
      modified: "def keep():\n    return 1\ndef added():\n    return 4\n",
      line: 3, originalLine: 3,
    },
  });
  await page.getByLabel("Show changes", { exact: true }).selectOption("lastCommit");
  await page.getByRole("button", { name: "Expand change list" }).click();
  await expect(page.getByRole("button", { name: "Added block added +2 −0" })).toBeVisible();
  await page.getByRole("button", { name: "Removed block retired +0 −2" }).click();
  const inspector = page.getByLabel("Source inspector for retired");
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText("COMMIT swap", { exact: true })).toBeVisible();
  await expect(inspector.locator("code")).toHaveText("scripts/job.py");
  await expect(inspector.getByRole("button", { name: "Open in editor" })).toBeDisabled();
  await expect(inspector.getByLabel("Changes to scripts/job.py")).toBeVisible();
  await expect(inspector.locator(".view-lines").filter({ hasText: "def retired():" }).first()).toBeVisible();
  await expect(inspector.locator(".view-lines").filter({ hasText: "def added():" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(inspector).toBeHidden();
});

test.describe("commit diff (ipc)", () => {
  test.beforeEach(async ({ page }) => gotoIpc(page));

  async function pickThrough(page: import("@playwright/test").Page) {
    const select = page.getByLabel("Show changes", { exact: true });
    await expect(select).toBeVisible();
    const options = await select.locator("option").count();
    expect(options).toBeGreaterThan(1);
    await select.selectOption("lastCommit");
  }

  test("DIFF-01: Show changes selector offers presets", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByLabel("Show changes", { exact: true })).toHaveValue("lastCommit");
  });

  test("DIFF-02: Custom presents older From before newer To", async ({ page }) => {
    await pickThrough(page);
    await page.getByLabel("Show changes", { exact: true }).selectOption("custom");
    await expect(page.getByLabel("From (older commit, excluded)")).toBeVisible();
    await expect(page.getByLabel("To (newer commit, included)")).toBeVisible();
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
    // The checkbox is controlled: a dead onChange leaves it unchecked, so
    // asserting the checked state both ways proves the toggle really flips.
    const toggle = page.getByRole("checkbox", { name: "Only show changed blocks on the map and file tree" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });

  test("DIFF-07: Prev / Next navigation is present", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByRole("button", { name: /prev|next/i }).first()).toBeVisible();
  });

  test("DIFF-08: bracket keys navigate changes", async ({ page }) => {
    await pickThrough(page);
    // Two captured entries: the changed block, then the outside-map file.
    const position = page.locator(".commit-diff-position");
    await expect(position).toHaveText("1 / 2");
    // Drop focus from the range selects first: the bracket handler
    // ignores keys typed inside inputs and selects, and clicking the banner
    // to blur can land on its wrapped controls in narrow viewports.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("]");
    await expect(position).toHaveText("2 / 2");
    // The second entry is the outside-map file, so its diff inspector opens.
    await expect(page.getByLabel("Source inspector for README.md")).toBeVisible();
    await page.keyboard.press("[");
    await expect(position).toHaveText("1 / 2");
  });

  test("DIFF-09: change list expands", async ({ page }) => {
    await pickThrough(page);
    const expand = page.getByRole("button", { name: /expand|changes/i }).first();
    await expand.click();
    await expect(page.getByText(/\+3/).first()).toBeVisible();
  });

  test("DIFF-10: block diff view opens for a changed block", async ({ page }) => {
    await pickThrough(page);
    await expect(page.getByLabel("Source inspector for main")).toHaveCount(0);
    const expand = page.getByRole("button", { name: /expand|changes/i }).first();
    await expand.click();
    await page.getByRole("button", { name: /Block main/ }).click();
    // The inspector opens on the changed block showing its commit diff.
    await expect(page.getByLabel("Source inspector for main")).toBeVisible();
    await expect(page.getByText(/^COMMIT /)).toBeVisible();
  });

  test("DIFF-11: outside-map file entry is listed", async ({ page }) => {
    await pickThrough(page);
    const expand = page.getByRole("button", { name: /expand|changes/i }).first();
    await expand.click();
    await expect(page.getByText("README.md").first()).toBeVisible();
  });
});
