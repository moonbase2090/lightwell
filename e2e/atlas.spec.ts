import { test, expect, gotoIpc, gotoWeb } from "./helpers.js";
import type { Page } from "@playwright/test";

// WCAG 2.x relative luminance and contrast ratio, written out here so the
// expected threshold does not depend on any app code.
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: readonly number[]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(foreground: readonly number[], background: readonly number[]): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Text colour and the first opaque background behind an element, as RGB triples. */
async function colours(page: Page, selector: string): Promise<{ text: number[]; background: number[] }> {
  return page.locator(selector).first().evaluate((element) => {
    const parse = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number);
    let background = [0, 0, 0, 0];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const candidate = parse(getComputedStyle(node).backgroundColor);
      if (candidate.length >= 3 && (candidate[3] ?? 1) === 1) {
        background = candidate;
        break;
      }
    }
    return { text: parse(getComputedStyle(element).color).slice(0, 3), background: background.slice(0, 3) };
  });
}

test.describe("workspace atlas first run and empty projects", () => {
  test("ATLAS-01: with no recent workspaces the app asks for a project folder and draws no atlas", async ({ page }) => {
    await gotoIpc(page, { workspaces: [] });
    await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
    await expect(page.getByText("Choose a project folder to build its local architecture map.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose project folder" })).toBeEnabled();
    await expect(page.getByRole("tree", { name: "Workspace atlas outline" })).toHaveCount(0);
    await expect(page.locator(".atlas-cell")).toHaveCount(0);
  });
});

test.describe("workspace atlas empty workspace", () => {
  test("ATLAS-06: a workspace with no child blocks opens without errors and shows an empty outline", async ({ page }) => {
    const id = "workspace:empty";
    const facts = {
      schemaVersion: 1,
      project: { id, name: "Empty", rootPath: "." },
      blocks: [{ type: "workspace", id, label: "Empty", parentId: null, children: [], sourcePath: "Cargo.toml", fingerprint: "0".repeat(64), memberCount: 0 }],
      connections: [],
      groups: [],
      stats: { blocks: 1, connections: 0, crates: 0, apps: 0, modules: 0, cargoFeatures: 0 },
    };
    const maps = {
      [id]: { facts, annotations: { schemaVersion: 1, projectId: id, blocks: {}, features: [], groups: [] }, projectNotes: { kind: "ready", notes: [] } },
    };
    await gotoIpc(page, { workspaces: [{ id, label: "Empty" }], maps: { ...maps } }, "atlas");
    await expect(page.getByRole("tree", { name: "Workspace atlas outline" })).toBeVisible();
    await expect(page.locator(".atlas-edges path")).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Dependencies for/ })).toHaveCount(0);
  });
});

test.describe("workspace atlas dependency lens", () => {
  test.beforeEach(async ({ page }) => gotoWeb(page, "atlas"));

  test("ATLAS-02: a block with no dependencies reads 0 incoming 0 outgoing and draws no edges", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("cell_grid");
    await page.getByRole("treeitem", { name: /cell_grid/i }).last().click();
    const lens = page.getByRole("region", { name: "Dependencies for cell_grid" });
    await expect(lens).toBeVisible();
    await expect(lens.getByText("0 incoming")).toBeVisible();
    await expect(lens.getByText("0 outgoing")).toBeVisible();
    await expect(lens.locator(".atlas-relation-row")).toHaveCount(0);
    await expect(page.locator(".atlas-edges path")).toHaveCount(0);
  });

  test("ATLAS-03: a connected block lists each relation and draws its edges", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("apple");
    await page.getByRole("treeitem", { name: /^apple(?!-)/i }).click();
    const lens = page.getByRole("region", { name: "Dependencies for apple" });
    await expect(lens.getByText("1 incoming")).toBeVisible();
    await expect(lens.getByText("1 outgoing")).toBeVisible();
    await expect(lens.locator(".atlas-relation-row")).toHaveCount(2);
    await expect(lens.locator(".atlas-relation-row").first()).toContainText(/^(IN|OUT)/);
    await expect(page.locator(".atlas-edges path").first()).toBeVisible();
  });

  test("ATLAS-04: Clear returns from the lens to the unselected atlas", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("cell_grid");
    await page.getByRole("treeitem", { name: /cell_grid/i }).last().click();
    await expect(page.getByRole("region", { name: "Dependencies for cell_grid" })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByRole("region", { name: /^Dependencies for/ })).toHaveCount(0);
  });
});

for (const theme of ["dark", "light"] as const) {
  test.describe(`workspace atlas contrast (${theme})`, () => {
    test.beforeEach(async ({ page }) => {
      await gotoWeb(page, "atlas");
      await page.getByRole("button", { name: /settings/i }).first().click();
      await page.getByRole("combobox", { name: "THEME" }).selectOption(theme);
      await page.getByRole("button", { name: "Close settings" }).click();
    });

    test(`ATLAS-05: outline, empty-result and lens text meet 4.5:1 in the ${theme} theme`, async ({ page }) => {
      // Open a connected block so the lens is on screen with its counts and rows.
      await page.getByLabel("Filter workspace atlas").fill("apple");
      await page.getByRole("treeitem", { name: /^apple(?!-)/i }).click();
      const checks: [string, string][] = [
        ["outline row", ".atlas-outline-row"],
        ["outline kind label", ".atlas-outline-kind"],
        ["selected outline row", ".atlas-outline-row.is-selected"],
        ["lens heading", ".atlas-relations-heading strong"],
        ["lens counts", ".atlas-relation-counts span"],
        ["lens relation direction", ".atlas-relation-row span"],
        ["lens Clear action", ".atlas-relations-heading button"],
      ];
      for (const [name, selector] of checks) {
        const { text, background } = await colours(page, selector);
        expect(ratio(text, background), `${name} (${selector}) is ${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      // The empty-result message only exists with a filter that matches nothing.
      await page.getByLabel("Filter workspace atlas").fill("zzzz-no-such-block");
      await expect(page.getByText("No matching blocks")).toBeVisible();
      const empty = await colours(page, ".atlas-empty");
      expect(ratio(empty.text, empty.background), `empty message is ${empty.text} on ${empty.background}`).toBeGreaterThanOrEqual(4.5);
    });
  });
}
