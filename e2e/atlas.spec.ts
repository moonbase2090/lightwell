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

  test("ATLAS-02: a block with no depends-on links lists its parent and draws no edges", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("cell_grid");
    await page.getByRole("treeitem", { name: /cell_grid/i }).last().click();
    const lens = page.getByRole("region", { name: "Dependencies for cell_grid" });
    await expect(lens).toBeVisible();
    await expect(lens.getByText("1 incoming")).toBeVisible();
    await expect(lens.getByText("0 outgoing")).toBeVisible();
    await expect(lens.locator(".atlas-relation-row")).toHaveCount(1);
    await expect(lens.getByRole("button", { name: /^IN contains / })).toBeVisible();
    await expect(page.locator(".atlas-edges path")).toHaveCount(0);
  });

  test("ATLAS-03: a connected block lists containment and dependency relations", async ({ page }) => {
    await page.getByLabel("Filter workspace atlas").fill("apple");
    await page.getByRole("treeitem", { name: /^apple(?!-)/i }).click();
    const lens = page.getByRole("region", { name: "Dependencies for apple" });
    await expect(lens.getByText("2 incoming")).toBeVisible();
    await expect(lens.getByText("1 outgoing")).toBeVisible();
    await expect(lens.locator(".atlas-relation-row")).toHaveCount(3);
    await expect(lens.getByRole("button", { name: /^IN contains / })).toBeVisible();
    await expect(lens.getByRole("button", { name: /^IN depends / })).toBeVisible();
    await expect(lens.getByRole("button", { name: /^OUT depends / })).toBeVisible();
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

test.describe("workspace atlas zoomed labels", () => {
  test("ATLAS-07: zoomed in, every label sits inside its cell and corners stay small on screen", async ({ page }) => {
    await gotoWeb(page, "atlas");
    const shapes = page.locator(".atlas-cell-shape");
    // Double-click the largest folder cell repeatedly to zoom well in.
    for (let step = 0; step < 3; step += 1) {
      const target = await shapes.evaluateAll((nodes) => {
        const boxes = nodes.map((node, index) => ({ index, box: node.getBoundingClientRect() }))
          .filter((entry) => entry.box.width > 0 && entry.box.x >= 0 && entry.box.y >= 0 && entry.box.width < window.innerWidth * 0.95);
        boxes.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
        const pick = boxes[0];
        return pick === undefined ? null : { x: pick.box.x + pick.box.width / 2, y: pick.box.y + pick.box.height / 2 };
      });
      if (target === null) break;
      await page.mouse.dblclick(target.x, target.y);
    }
    const report = await page.locator(".atlas-cell").evaluateAll((cells) => cells.flatMap((cell) => {
      const text = cell.querySelector("text");
      const shape = cell.querySelector(".atlas-cell-shape");
      if (text === null || shape === null) return [];
      const t = text.getBoundingClientRect();
      const s = shape.getBoundingClientRect();
      const rx = Number(shape.getAttribute("rx") ?? 0) * (s.width / Math.max(Number(shape.getAttribute("width")), 0.0001));
      return [{ label: text.textContent ?? "", outside: t.left < s.left - 1 || t.right > s.right + 1 || t.top < s.top - 1 || t.bottom > s.bottom + 1, rx }];
    }));
    expect(report.length).toBeGreaterThan(0);
    for (const entry of report) {
      expect(entry.outside, `label ${entry.label} escapes its cell`).toBe(false);
      expect(entry.rx, `label ${entry.label} cell corner radius on screen`).toBeLessThanOrEqual(8.5);
    }
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
      await expect(page.locator(".atlas-empty")).toHaveText("No matching blocks");
      const empty = await colours(page, ".atlas-empty");
      expect(ratio(empty.text, empty.background), `empty message is ${empty.text} on ${empty.background}`).toBeGreaterThanOrEqual(4.5);
    });
  });
}

test.describe("atlas label detail", () => {
  test("fit shows group labels, zoom reveals readable detail in the UI monospace font", async ({ page }) => {
    await gotoWeb(page, "atlas");
    const svg = page.getByLabel("Workspace treemap");
    await expect(svg.locator(".atlas-cell")).not.toHaveCount(0);
    await expect(svg.locator(".atlas-cell.depth-1 text").filter({ hasText: "crates" })).toBeVisible();
    await expect(svg.locator(".atlas-cell:not(.depth-0):not(.depth-1) text")).toHaveCount(0);
    const textFont = await svg.locator("text").first().evaluate((node) => getComputedStyle(node).fontFamily);
    const controlFont = await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Atlas", exact: true }).evaluate((node) => getComputedStyle(node).fontFamily);
    expect(textFont).toBe(controlFont);
    const labelPixels = await svg.locator("text").first().evaluate((node) => {
      if (!(node instanceof SVGGraphicsElement)) return 0;
      return parseFloat(getComputedStyle(node).fontSize) * (node.getScreenCTM()?.a ?? 0);
    });
    expect(labelPixels).toBeCloseTo(11, 1);
    await svg.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      for (let count = 0; count < 12; count += 1) {
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: true }));
      }
    });
    await expect.poll(() => svg.locator(".atlas-cell:not(.depth-0):not(.depth-1) text").count()).toBeGreaterThan(0);
    const labels = await svg.locator("text").allTextContents();
    expect(labels.some((label) => label.endsWith("…") && label.length < 8)).toBe(false);
    await page.getByRole("button", { name: "Fit workspace" }).click();
    await expect(svg.locator(".atlas-cell:not(.depth-0):not(.depth-1) text")).toHaveCount(0);
  });

  test("selecting an Atlas block opens source immediately and follows the next selection", async ({ page }) => {
    await gotoIpc(page, {}, "atlas");
    await page.getByLabel("Filter workspace atlas").fill("main");
    await page.getByRole("treeitem", { name: /main/i }).last().click();
    await expect(page.getByLabel(/Source inspector for/)).toBeVisible();
    await expect(page.getByText("READ-ONLY SOURCE")).toBeVisible();
    await expect(page.locator('.source-code-editor [aria-label^="Read-only source:"]').first()).toHaveAttribute("aria-label", /main\.mjs/);
    await page.getByLabel("Filter workspace atlas").fill("Prismattyc");
    await page.getByRole("treeitem", { name: /Prismattyc/i }).first().click();
    await expect(page.locator('.source-code-editor [aria-label^="Read-only source:"]').first()).toHaveAttribute("aria-label", /Cargo\.toml/);
    await expect(page.locator(".source-code-editor .monaco-editor")).toHaveCount(1);
  });
});
