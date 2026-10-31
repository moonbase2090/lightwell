#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const repo = process.cwd();
const outputDir = path.resolve(process.argv[2] ?? "docs/proof/dependency-chart");
const largeFactsPath = path.resolve(process.argv[3] ?? "maps/prismattyc.facts.json");
const largeAnnotationsPath = path.resolve(process.argv[4] ?? "maps/prismattyc.annotations.json");
const temporaryDir = mkdtempSync(path.join(tmpdir(), "lightwell-dependency-proof-"));
const lightwellFactsPath = path.join(temporaryDir, "lightwell.facts.json");

try {
  run("./node_modules/.bin/tsx", ["src/cli.ts", "extract", repo, "-o", lightwellFactsPath, "--name", "Lightwell"]);
  run("npm", ["run", "build"], { VITE_ENABLE_COMPOUND_LAYOUT: "true" });
  mkdirSync(outputDir, { recursive: true });

  const port = await availablePort();
  const preview = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: repo,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let previewError = "";
  preview.stderr.on("data", (chunk) => { previewError += String(chunk); });

  try {
    await waitForPreview(`http://127.0.0.1:${port}`);
    const lightwellFacts = readJson(lightwellFactsPath);
    const largeFacts = readJson(largeFactsPath);
    const maps = [
      {
        slug: "lightwell",
        label: "Lightwell",
        facts: lightwellFacts,
        annotations: emptyAnnotations(lightwellFacts),
        detailBlockIds: rootChildrenForDetail(lightwellFacts),
      },
      {
        slug: "large-workspace",
        label: "Large workspace",
        facts: largeFacts,
        annotations: readJson(largeAnnotationsPath),
        detailBlockIds: rootChildrenForDetail(largeFacts),
      },
    ];
    const browser = await chromium.launch({ headless: true });
    const proof = [];
    try {
      for (const map of maps) {
        proof.push(await captureMap({
          browser,
          baseUrl: `http://127.0.0.1:${port}`,
          outputDir,
          map,
        }));
      }
    } finally {
      await browser.close();
    }
    writeFileSync(path.join(outputDir, "results.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    for (const result of proof) {
      console.log(`${result.label}: overview ${result.overview.legend}; detail ${result.detail.legend}`);
    }
  } finally {
    preview.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => {
      preview.once("exit", (code) => resolve(code));
      setTimeout(() => resolve(null), 5_000);
    });
    if (exitCode !== null && exitCode !== 0 && exitCode !== 143) {
      throw new Error(`Preview exited with ${exitCode}: ${previewError.trim()}`);
    }
  }
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} failed with ${result.status}`);
  }
  process.stdout.write(result.stdout);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function emptyAnnotations(facts) {
  return {
    schemaVersion: facts.schemaVersion,
    projectId: facts.project.id,
    blocks: {},
    features: [],
    groups: [],
  };
}

function rootChildrenForDetail(facts) {
  const blockById = new Map(facts.blocks.map((block) => [block.id, block]));
  const root = blockById.get(facts.project.id);
  if (root === undefined) throw new Error(`Facts are missing their workspace block: ${facts.project.id}`);
  const subtreeIds = (id) => {
    const block = blockById.get(id);
    const result = new Set([id]);
    if (block === undefined) return result;
    for (const childId of block.children) {
      for (const descendantId of subtreeIds(childId)) result.add(descendantId);
    }
    return result;
  };
  const candidates = root.children.map((id) => {
    const descendants = subtreeIds(id);
    const dependencyEdges = facts.connections.filter((connection) => connection.kind === "depends_on"
      && descendants.has(connection.source)
      && descendants.has(connection.target)).length;
    return { id, dependencyEdges, blocks: descendants.size };
  });
  return candidates
    .sort((left, right) => right.dependencyEdges - left.dependencyEdges
      || right.blocks - left.blocks
      || left.id.localeCompare(right.id))
    .map((candidate) => candidate.id);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a preview port.");
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function waitForPreview(baseUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The preview process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Preview did not start within 20 seconds.");
}

async function captureMap({ browser, baseUrl, outputDir: captures, map }) {
  const context = await browser.newContext({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(String(error)));
  await page.addInitScript(({ label, facts, annotations }) => {
    const callbacks = new Map();
    const w = window;
    const document = { facts, annotations, projectNotes: { kind: "ready", notes: [] } };
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        switch (command) {
          case "recent_workspaces": return [{ id: "proof", label }];
          case "load_workspace_map":
          case "watch_workspace": return document;
          case "recent_workspace_commits": return [];
          case "load_editor_settings": return { commandTemplate: null };
          case "editor_template_presets": return [];
          case "update_delivery": return "manual";
          case "plugin:event|listen": return 1;
          case "plugin:event|emit":
          case "plugin:event|emit_to":
          case "plugin:event|unlisten": return undefined;
          case "plugin:updater|check": return null;
          default: return undefined;
        }
      },
      transformCallback: (callback) => {
        const id = callbacks.size + 1;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id) => callbacks.delete(id),
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => callbacks.delete(id),
    };
  }, { label: map.label, facts: map.facts, annotations: map.annotations });

  try {
    await page.goto(baseUrl);
    await page.locator(".dependency-legend").waitFor({ state: "visible" });
    const initialStats = (await page.locator(".dependency-layout-stats").innerText()).trim();
    await page.getByLabel("Map depth").first().selectOption("all");
    await page.locator(".react-flow__node-compoundGroup").first().waitFor({ state: "visible" });
    await page.waitForFunction(
      (previous) => document.querySelector(".dependency-layout-stats")?.textContent?.trim() !== previous,
      initialStats,
    );
    await clearGraphHover(page);
    await page.screenshot({ path: path.join(captures, `${map.slug}-overview.png`), fullPage: true });
    const overview = await graphSnapshot(page, `${map.slug}-overview.png`);

    const overviewStats = overview.legend;
    let detailBlockId;
    for (const blockId of map.detailBlockIds) {
      const header = page.locator(`.react-flow__node[data-id=${JSON.stringify(blockId)}] .compound-group-header`);
      if (await header.count() === 0) continue;
      await header.click();
      detailBlockId = blockId;
      break;
    }
    if (detailBlockId === undefined) throw new Error(`${map.label} has no rendered child group for its detail capture.`);
    await page.waitForFunction(
      (previous) => document.querySelector(".dependency-layout-stats")?.textContent?.trim() !== previous,
      overviewStats,
    );
    const closeInspector = page.getByLabel("Close source inspector");
    if (await closeInspector.count() > 0) await closeInspector.click();
    await page.locator(".react-flow__controls-fitview").click();
    await clearGraphHover(page);
    await page.screenshot({ path: path.join(captures, `${map.slug}-detail.png`), fullPage: true });
    const detail = await graphSnapshot(page, `${map.slug}-detail.png`);
    if (browserErrors.length > 0) throw new Error(browserErrors.join("\n"));
    return {
      label: map.label,
      sourceBlocks: map.facts.stats.blocks,
      sourceConnections: map.facts.stats.connections,
      detailBlockId,
      overview,
      detail,
    };
  } finally {
    await context.close();
  }
}

async function graphSnapshot(page, screenshot) {
  return {
    legend: (await page.locator(".dependency-layout-stats").innerText()).trim(),
    groupNodes: await page.locator(".react-flow__node-compoundGroup").count(),
    leafNodes: await page.locator(".react-flow__node-codeBlock").count(),
    summaryNodes: await page.locator(".react-flow__node-compoundSummary").count(),
    dimmedNodes: await page.locator(".block-node.dimmed, .compound-group.dimmed, .compound-summary.dimmed").count(),
    edges: await page.locator(".react-flow__edge-orthogonal").count(),
    screenshot,
  };
}

async function clearGraphHover(page) {
  await page.locator(".block-node").first().hover();
  await page.locator(".topbar").hover();
  await page.waitForTimeout(150);
}
