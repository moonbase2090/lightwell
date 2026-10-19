import { test, expect, gotoWeb, gotoIpc } from "./helpers.js";

test.describe("app shell (web)", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page));

  test("APP-01: project selector switches the viewer", async ({ page }) => {
    const select = page.getByRole("combobox", { name: "PROJECT" });
    await select.selectOption({ label: "Scorecard" });
    await expect(page.getByLabel("Project summary")).toContainText("Scorecard");
  });

  test("APP-03: search input filters blocks", async ({ page }) => {
    const search = page.getByPlaceholder("Search blocks and features…");
    await search.fill("main");
    await expect(page.getByLabel("Map search results")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
  });

  test("APP-04: search results list picks first match on Enter", async ({ page }) => {
    await page.getByPlaceholder("Search blocks and features…").fill("main");
    await expect(page.getByLabel("Map search results")).toContainText("main");
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("Search blocks and features…")).toHaveValue("");
  });

  test("APP-04b: empty search reads No matching blocks", async ({ page }) => {
    await page.getByPlaceholder("Search blocks and features…").fill("zzz-no-such-block-zzz");
    await expect(page.getByText("No matching blocks")).toBeVisible();
  });

  test("APP-05: Cmd/Ctrl+K focuses search", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByPlaceholder("Search blocks and features…")).toBeFocused();
  });

  test("APP-06: settings button opens Settings dialog", async ({ page }) => {
    // Narrow-only: the Settings button is occluded by the search field at 920px.
    test.fixme(
      test.info().project.name === "narrow",
      "https://github.com/moonbase2090/lightwell/issues/155",
    );
    await page.getByRole("button", { name: /settings/i }).first().click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeHidden();
  });

  test("APP-07: LOCAL MAP indicator and status bar are visible", async ({ page }) => {
    await expect(page.getByText("LOCAL MAP")).toBeVisible();
    await expect(page.getByLabel("Project summary")).toBeVisible();
  });

  test("APP-08: project summary row shows totals", async ({ page }) => {
    const summary = page.getByLabel("Project summary");
    await expect(summary).toContainText("Prismattyc");
    await expect(summary).toContainText("ready");
  });

  test("APP-09: map becomes ready after loading", async ({ page }) => {
    await expect(page.getByLabel("Project summary")).toContainText("ready");
  });

  test("APP-13: default theme is blueprint on the shell", async ({ page }) => {
    // Narrow-only: the Settings button is occluded by the search field at 920px.
    test.fixme(
      test.info().project.name === "narrow",
      "https://github.com/moonbase2090/lightwell/issues/155",
    );
    // A saved preference always wins over the default, so reset storage
    // first instead of accepting whatever carried over.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.getByLabel("Project summary")).toBeVisible();
    // The shell carries the resolved theme (see theme.ts resolveTheme).
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-theme", "blueprint");
    await page.getByRole("button", { name: /settings/i }).first().click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });
});

test.describe("app shell (ipc)", () => {
  test("APP-02: open workspace button runs open_workspace via dialog stub", async ({ page }) => {
    await gotoIpc(page);
    // Start on the second workspace so the open action must visibly move
    // the viewer: it already shows the first entry when the handler is a
    // no-op, which the old assertion could not tell apart.
    const select = page.getByRole("combobox", { name: "PROJECT" });
    await select.selectOption({ label: "Scorecard" });
    await expect(page.getByLabel("Project summary")).toContainText("Scorecard");
    const btn = page.getByRole("button", { name: /open.*workspace|choose rust workspace/i }).first();
    await expect(btn).toBeVisible();
    await btn.click();
    // Dialog is stubbed at the IPC layer; open_workspace resolves to the
    // first fixture entry, so the viewer switches back to it. A no-op or
    // rejected command leaves Scorecard showing (or renders an alert).
    await expect(page.getByLabel("Project summary")).toContainText("Prismattyc");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("APP-11: workspace list is offered by the mocked source", async ({ page }) => {
    await gotoIpc(page);
    await expect(page.getByLabel("Project summary")).toBeVisible();
    // recent_workspaces answers from the captures fixture, so the project
    // selector offers exactly those workspace entries.
    const select = page.getByRole("combobox", { name: "PROJECT" });
    await expect(select.locator("option")).toHaveText(["Prismattyc", "Scorecard"]);
  });

  test("APP-12: no workspace error banner after a clean mocked load", async ({ page }) => {
    await gotoIpc(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("APP-14: mocked watch keeps the map ready", async ({ page }) => {
    await gotoIpc(page);
    await expect(page.getByLabel("Project summary")).toContainText("ready");
  });
});
