import type { Page } from "@playwright/test";
import type { FactMap, ModuleBlock } from "../src/model.js";
import { test, expect, gotoIpc } from "./helpers.js";

const rootId = "workspace:definitions";
const facts: FactMap = {
  schemaVersion: 1,
  project: { id: rootId, name: "Definitions fixture", rootPath: "." },
  blocks: [
    { id: rootId, label: "Definitions fixture", type: "workspace", parentId: null, children: ["main", "helpers"], sourcePath: "Cargo.toml", fingerprint: "root", memberCount: 1 },
    ...["main", "helpers"].map((name): ModuleBlock => ({ id: name, label: name, type: "module", parentId: rootId, children: [], sourcePath: `src/${name}.rs`, fingerprint: name, packageName: "fixture", modulePath: name, declaredByPath: "src/main.rs", cfgAttributes: [], unresolved: false })),
  ],
  connections: ["main", "helpers"].map((name) => ({ id: `contains:${name}`, source: rootId, target: name, kind: "contains" })),
  groups: [],
  stats: { blocks: 3, connections: 2, crates: 0, apps: 0, modules: 2, cargoFeatures: 0 },
};
const definitions = [
  { name: "calculate", blockId: "helpers", line: 4, column: 8 },
  { name: "other", blockId: "helpers", line: 5, column: 8 },
  { name: "duplicate", blockId: "main", line: 7, column: 4 },
  { name: "duplicate", blockId: "helpers", line: 6, column: 8 },
];

async function openFixture(page: Page, definitionDelayMs = 0) {
  await gotoIpc(page, {
    workspaces: [{ id: "definitions", label: "Definitions fixture" }],
    maps: { definitions: { facts, annotations: { schemaVersion: 1, projectId: rootId, blocks: {}, features: [], groups: [] }, projectNotes: { kind: "ready", notes: [] } } },
    sources: {
      main: { path: "src/main.rs", content: "mod helpers;\nfn main() {\n    helpers::calculate();\n    missing();\n    duplicate();\n}\nfn duplicate() {}\n", line: 1, column: 1 },
      helpers: { path: "src/helpers.rs", content: "// Helpers\n// Stable fixture\n//\npub fn calculate() -> i32 { 7 }\npub fn other() -> i32 { calculate() }\npub fn duplicate() {}\n", line: 1, column: 1 },
    },
    definitions,
    definitionDelayMs,
  }, "atlas");
  await chooseFile(page, "main");
}

async function chooseFile(page: Page, name: string) {
  await page.getByLabel("Filter workspace atlas").fill(name);
  await page.getByRole("treeitem", { name: new RegExp(`${name}.*MODULE`, "i") }).last().click();
  await expect(page.locator(".source-code-editor .monaco-editor")).toBeVisible();
}

async function cursorAt(page: Page, position: string) {
  await page.locator(".source-code-editor .monaco-editor").click();
  await page.keyboard.press("Control+g");
  const input = page.locator(".quick-input-widget input");
  await expect(input).toBeVisible();
  await input.fill(`:${position}`);
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
}

test("F12 opens a symbol declaration, reuses the index, and normal selection clears its position", async ({ page }) => {
  await openFixture(page);
  await cursorAt(page, "3:17");
  await page.keyboard.press("F12");
  await expect(page.getByLabel("Source inspector for helpers", { exact: true })).toBeVisible();
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 4\s+COLUMN 8/);
  await expect(page.getByRole("textbox", { name: "Read-only source: src/helpers.rs", exact: true })).toBeFocused();
  await cursorAt(page, "5:30");
  await page.keyboard.press("F12");
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 4\s+COLUMN 8/);
  await expect.poll(() => page.evaluate("window.__LW_DEFINITION_CALLS__")).toBe(1);
  await chooseFile(page, "main");
  await chooseFile(page, "helpers");
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
});

test("Ctrl or Cmd click opens the clicked symbol definition", async ({ page }) => {
  await openFixture(page);
  const point = await page.locator(".source-code-editor .view-lines").evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const offset = node.textContent?.indexOf("calculate") ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 9);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error("The symbol call is not rendered.");
  });
  await page.keyboard.down("ControlOrMeta");
  try { await page.mouse.click(point.x, point.y); }
  finally { await page.keyboard.up("ControlOrMeta"); }
  await expect(page.getByLabel("Source inspector for helpers", { exact: true })).toBeVisible();
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 4\s+COLUMN 8/);
});

test("module jumps still work and ambiguous or unknown words leave the source alone", async ({ page }) => {
  await openFixture(page);
  for (const position of ["4:8", "5:8"]) {
    await cursorAt(page, position);
    await page.keyboard.press("F12");
    await expect.poll(() => page.evaluate("Boolean(window.__LW_DEFINITION_COMPLETED__)")).toBe(true);
    await expect(page.getByLabel("Source inspector for main", { exact: true })).toBeVisible();
    await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
  }
  await cursorAt(page, "3:8");
  await page.keyboard.press("F12");
  await expect(page.getByLabel("Source inspector for helpers", { exact: true })).toBeVisible();
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
});

test("a watched map refresh invalidates the cached definition index", async ({ page }) => {
  await openFixture(page);
  await cursorAt(page, "3:17");
  await page.keyboard.press("F12");
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 4\s+COLUMN 8/);
  await chooseFile(page, "main");
  await page.evaluate("window.__LW_REFRESH_DEFINITIONS__('definitions', [])");
  await expect(page.getByLabel("Source inspector for main", { exact: true })).toBeVisible();
  await cursorAt(page, "3:17");
  await page.keyboard.press("F12");
  await expect.poll(() => page.evaluate("window.__LW_DEFINITION_CALLS__")).toBe(2);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByLabel("Source inspector for main", { exact: true })).toBeVisible();
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
});

for (const name of ["helpers", "main"]) test(`a slow definition response cannot replace a newer ${name} selection`, async ({ page }) => {
  await openFixture(page, 800);
  await cursorAt(page, "3:17");
  await page.keyboard.press("F12");
  await expect.poll(() => page.evaluate("window.__LW_DEFINITION_CALLS__")).toBe(1);
  await chooseFile(page, name);
  await expect.poll(() => page.evaluate("Boolean(window.__LW_DEFINITION_COMPLETED__)")).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByLabel(`Source inspector for ${name}`, { exact: true })).toBeVisible();
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
});
