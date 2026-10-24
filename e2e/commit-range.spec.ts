import { test, expect, gotoIpc } from "./helpers.js";
const head = { id: "newer", shortId: "newer", summary: "Latest change", timestamp: 20 };
const base = { id: "older", shortId: "older", summary: "Release", timestamp: 10 };
const changes = { commit: head, baseCommit: base, files: [], blocks: [], connections: [] };
const range = { commit: head, baseCommit: base, commitCount: 3, releaseTag: null };

test("custom uses older-to-newer controls and the exact resolved count, not picker length", async ({ page }, info) => {
 await gotoIpc(page, { commits: [head, base], changes, ranges: { custom: range } });
 await page.getByLabel("Show changes", { exact: true }).selectOption("custom");
 const from = page.getByLabel("From (older commit, excluded)");
 const to = page.getByLabel("To (newer commit, included)");
 await expect(from).toBeEnabled();
 await expect(from.locator("option")).toHaveText(["Before To (one commit)", "older Release"]);
 await from.selectOption("older");
 await expect(to).toHaveValue("newer");
 await expect(page.locator(".commit-diff-summary-text")).toHaveText("3 commits after older through newer · 0 blocks changed");
 expect(await page.evaluate(() => Reflect.get(window, "__LW_RANGE_INPUT__"))).toMatchObject({ through: "newer", preset: { kind: "custom", from: "older" } });
 expect(await page.evaluate(() => Reflect.get(window, "__LW_RANGE_DIFF_INPUT__"))).toMatchObject({ commit: "newer", baseCommit: "older" });
 const positions = await from.evaluate((el) => {
  const other = document.querySelector('[aria-label="To (newer commit, included)"]');
  return other !== null && Boolean(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
 });
 expect(positions).toBe(true);
 await from.focus(); await page.keyboard.press("Tab"); await expect(to).toBeFocused();
 const bounds = await page.locator(".commit-picker").evaluate((panel) => {
  const controls = [...panel.querySelectorAll("select")].map((el) => el.getBoundingClientRect());
  const r = panel.getBoundingClientRect();
  const banner = document.querySelector(".commit-diff-banner")?.getBoundingClientRect();
  return controls.every((c) => c.top >= r.top && c.bottom <= r.bottom && c.left >= r.left && c.right <= r.right)
    && banner !== undefined && r.bottom <= banner.top;
 });
 expect(bounds, "all range controls fit their panel before the summary").toBe(true);
 await page.screenshot({ path: `/tmp/lightwell-commit-range-proof/after-${info.project.name}-custom.png` });
 await page.getByRole("button", { name: "Clear", exact: true }).click();
 await expect(page.getByLabel("Show changes", { exact: true })).toHaveValue("off");
 await expect(from).toBeHidden();
});

test("presets show count and endpoints, missing tags clear the prior diff", async ({ page }, info) => {
 await gotoIpc(page, { commits: [head, base], changes, ranges: {
  lastFive: { ...range, commitCount: 5 }, sinceRelease: "No reachable version tag for this history. Choose Last commit or Custom."
 } });
 const picker = page.getByLabel("Show changes", { exact: true });
 await picker.selectOption("lastFive");
 await expect(page.locator(".commit-diff-summary-text")).toHaveText("5 commits after older through newer · 0 blocks changed");
 expect(await page.evaluate(() => Reflect.get(window, "__LW_RANGE_INPUT__"))).toMatchObject({ through: "newer", preset: { kind: "lastFive" } });
 await page.screenshot({ path: `/tmp/lightwell-commit-range-proof/after-${info.project.name}-preset.png` });
 await picker.selectOption("sinceRelease");
 await expect(page.getByText("No reachable version tag for this history. Choose Last commit or Custom.")).toBeVisible();
 await expect(page.locator(".commit-diff-summary-text")).toHaveCount(0);
});

test("a release at To is explicitly empty and makes no diff request", async ({ page }) => {
 await gotoIpc(page, { commits: [head], ranges: { sinceRelease: { commit: head, baseCommit: head, commitCount: 0, releaseTag: "v1.0.0" } } });
 await page.getByLabel("Show changes", { exact: true }).selectOption("sinceRelease");
 await expect(page.getByText("0 commits after release v1.0.0 through newer; 0 blocks changed.")).toBeVisible();
 expect(await page.evaluate(() => Reflect.get(window, "__LW_RANGE_DIFF_INPUT__"))).toBeUndefined();
});

test("short histories show an explanation and no unsupported Uncommitted option", async ({ page }) => {
 await gotoIpc(page, { commits: [head], ranges: { lastFive: "Last 5 commits needs an older base commit. This history has only 1 mainline commit; choose Last commit or Custom." } });
 const picker = page.getByLabel("Show changes", { exact: true });
 await expect(picker.locator("option")).toHaveText(["Off", "Last commit", "Last 5 commits", "Since last release", "Custom…"]);
 await picker.selectOption("lastFive");
 await expect(page.getByText(/This history has only 1 mainline/)).toBeVisible();
 expect(await page.evaluate(() => Reflect.get(window, "__LW_RANGE_DIFF_INPUT__"))).toBeUndefined();
});
