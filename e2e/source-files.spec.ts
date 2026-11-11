import type { Page } from "@playwright/test";
import type { FactMap, ModuleBlock } from "../src/model.js";
import { test, expect, gotoIpc } from "./helpers.js";

const rootId = "workspace:source-files";
const facts: FactMap = {
  schemaVersion: 1,
  project: { id: rootId, name: "Source files fixture", rootPath: "." },
  blocks: [
    { id: rootId, label: "Source files fixture", type: "workspace", parentId: null, children: ["main", "other"], sourcePath: "Cargo.toml", fingerprint: "root", memberCount: 1 },
    ...["main", "helpers", "inline", "other"].map((name): ModuleBlock => ({
      id: name, label: name, type: "module", parentId: name === "helpers" || name === "inline" ? "main" : rootId,
      children: name === "main" ? ["helpers", "inline"] : [], sourcePath: `src/${name === "inline" ? "main" : name}.rs`, fingerprint: name,
      packageName: "fixture", modulePath: name, declaredByPath: "src/main.rs", cfgAttributes: [], unresolved: false,
    })),
  ],
  connections: ["main", "helpers", "inline", "other"].map((name) => ({ id: `contains:${name}`, source: name === "helpers" || name === "inline" ? "main" : rootId, target: name, kind: "contains" })),
  groups: [], stats: { blocks: 5, connections: 4, crates: 0, apps: 0, modules: 4, cargoFeatures: 0 },
};

async function chooseBlock(page: Page, name: string) {
  await page.getByLabel("Filter workspace atlas").fill(name);
  await page.getByRole("treeitem", { name: new RegExp(`${name}.*MODULE`, "i") }).last().click();
  await expect(page.locator(".source-code-editor .monaco-editor")).toBeVisible();
}

async function openFixture(page: Page, slowHelpers = false) {
  await gotoIpc(page, {
    workspaces: [{ id: "source-files", label: "Source files fixture" }],
    maps: { "source-files": { facts, annotations: { schemaVersion: 1, projectId: rootId, blocks: {}, features: [], groups: [] }, projectNotes: { kind: "ready", notes: [] } } },
    sources: {
      main: { path: "src/main.rs", content: "mod helpers;\nfn main() { helpers::calculate(); }\n", line: 1, column: 1 },
      helpers: { path: "src/helpers.rs", content: "pub fn calculate() -> i32 { 7 }\n", line: 1, column: 1 },
      inline: { path: "src/main.rs", content: "mod helpers;\nfn main() { helpers::calculate(); }\n", line: 2, column: 1 },
      other: { path: "src/other.rs", content: "pub fn unrelated() {}\n", line: 1, column: 1 },
    },
    sourceDelays: slowHelpers ? { helpers: 800 } : {},
    definitions: [{ name: "calculate", blockId: "helpers", line: 1, column: 8 }],
  }, "atlas");
  await chooseBlock(page, "main");
}

test("switches among a block's files and returns to its primary file", async ({ page }) => {
  await openFixture(page);
  const picker = page.getByRole("combobox", { name: "Source file", exact: true });
  await expect(picker.locator("option:not([disabled])")).toHaveText(["src/main.rs", "src/helpers.rs"]);
  await picker.selectOption("helpers");
  await expect(page.locator(".source-inspector-title code")).toHaveText("src/helpers.rs");
  await expect(page.locator(".source-code-editor .view-lines")).toContainText("calculate");
  await picker.selectOption("main");
  await expect(page.locator(".source-inspector-title code")).toHaveText("src/main.rs");
  await expect(page.locator(".source-code-editor .view-lines")).toContainText("mod helpers");
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
});

test("editor and note actions target the displayed file's mapped block", async ({ page }) => {
  await openFixture(page);
  await page.getByRole("combobox", { name: "Source file", exact: true }).selectOption("helpers");
  const panel = page.getByLabel("Source inspector for helpers", { exact: true });
  await expect(panel.locator(".source-inspector-title code")).toHaveText("src/helpers.rs");
  await panel.getByRole("button", { name: "Open in editor", exact: true }).click();
  await expect.poll(() => page.evaluate("window.__LW_EDITOR_TARGET__")).toBe("helpers");
  await panel.getByRole("button", { name: /^Add note/ }).click();
  await page.getByLabel("Project note text").fill("Helper file note");
  await page.keyboard.press("Control+Enter");
  await page.getByRole("button", { name: "Close project notes" }).click();
  await expect(panel.getByLabel("Project note", { exact: true })).toContainText("Helper file note");
  await page.getByRole("combobox", { name: "Source file", exact: true }).selectOption("main");
  await expect(page.getByLabel("Source inspector for main", { exact: true }).getByRole("button", { name: /^Add note/ })).toBeVisible();
});

test("normal block selection starts a new file list and closing/reopening resets it", async ({ page }) => {
  await openFixture(page);
  await page.getByRole("combobox", { name: "Source file", exact: true }).selectOption("helpers");
  await chooseBlock(page, "other");
  await expect(page.locator(".source-inspector-title code")).toHaveText("src/other.rs");
  await expect(page.getByRole("combobox", { name: "Source file", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close source inspector", exact: true }).click();
  await chooseBlock(page, "main");
  await expect(page.getByRole("combobox", { name: "Source file", exact: true })).toHaveValue("main");
});

test("a slow file response cannot replace a newer file selection", async ({ page }) => {
  await openFixture(page, true);
  const picker = page.getByRole("combobox", { name: "Source file", exact: true });
  await picker.selectOption("helpers");
  await picker.selectOption("main");
  await expect(page.locator(".source-inspector-title code")).toHaveText("src/main.rs");
  await page.waitForTimeout(900);
  await expect(page.locator(".source-code-editor .view-lines")).toContainText("mod helpers");
  await expect(picker).toHaveValue("main");
});

test("a definition jump starts the target block's file list and normal selection resets its position", async ({ page }) => {
  await openFixture(page);
  await page.locator(".source-code-editor .monaco-editor").click();
  await page.keyboard.press("Control+g");
  const input = page.locator(".quick-input-widget input");
  await expect(input).toBeVisible();
  await input.fill(":2:26");
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
  await page.keyboard.press("F12");
  await expect(page.locator(".source-inspector-title code")).toHaveText("src/helpers.rs");
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 8/);
  await expect(page.getByRole("combobox", { name: "Source file", exact: true })).toHaveCount(0);
  await chooseBlock(page, "main");
  await expect(page.getByRole("combobox", { name: "Source file", exact: true })).toHaveValue("main");
  await expect(page.locator(".inspector-position")).toHaveText(/LINE 1\s+COLUMN 1/);
});
