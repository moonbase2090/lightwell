#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const urls = (process.argv[2] ?? "http://127.0.0.1:4173").split(",");
const output = path.resolve(process.argv[3] ?? "/tmp/lightwell-breadcrumb-proof");
const runs = Number(process.argv[4] ?? 5);
const facts = process.argv[5] === "--dense" ? denseWorkspace() : process.argv[5] === undefined ? null : JSON.parse(readFileSync(process.argv[5], "utf8"));
if (!Number.isInteger(runs) || runs < 1) throw new Error("Run count must be positive.");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (let run = 0; run < runs; run += 1) {
    for (let side = 0; side < urls.length; side += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.addInitScript(() => {
        window.breadcrumbProof = { requests: [], clickAt: 0 };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          pending = new Map();
          constructor(...args) {
            super(...args);
            this.addEventListener("message", (event) => {
              const entry = this.pending.get(event.data.generation);
              if (entry === undefined) return;
              entry.elapsedMs = performance.now() - entry.startedAt;
              entry.outcome = event.data.kind;
              entry.stats = event.data.result?.stats;
              this.pending.delete(event.data.generation);
            });
          }
          postMessage(message, ...args) {
            if (message.kind === "layout") {
              const entry = { rootId: message.input.rootId, limits: message.input.limits, startedAt: performance.now(), outcome: "pending" };
              this.pending.set(message.generation, entry);
              window.breadcrumbProof.requests.push(entry);
            }
            return super.postMessage(message, ...args);
          }
          terminate() {
            for (const entry of this.pending.values()) {
              entry.elapsedMs = performance.now() - entry.startedAt;
              entry.outcome = "terminated";
            }
            this.pending.clear();
            return super.terminate();
          }
        };
      });
      if (facts !== null) await page.addInitScript((facts) => {
        window.isTauri = true;
        const callbacks = new Map();
        const map = { facts, annotations: { schemaVersion: facts.schemaVersion, projectId: facts.project.id, blocks: {}, features: [], groups: [] }, projectNotes: { kind: "ready", notes: [] } };
        window.__TAURI_INTERNALS__ = {
          invoke: async (command) => {
            switch (command) {
              case "recent_workspaces": return [{ id: "proof", label: facts.project.name }];
              case "load_workspace_map":
              case "watch_workspace": return map;
              case "recent_workspace_commits": return [];
              case "load_editor_settings": return { commandTemplate: null };
              case "editor_template_presets": return [];
              case "update_delivery": return "manual";
              case "plugin:event|listen": return 1;
              case "plugin:updater|check": return null;
              default: return undefined;
            }
          },
          transformCallback: (callback) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
          unregisterCallback: (id) => callbacks.delete(id),
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => callbacks.delete(id) };
      }, facts);
      try {
        await page.goto(urls[side]);
        await page.getByRole("group", { name: "Map view" }).first().getByRole("button", { name: "Modules", exact: true }).click();
        await settled(page);
        const depth = page.getByLabel("Map depth").first();
        if (await depth.inputValue() !== "all") {
          await depth.selectOption("all");
          await settled(page);
        }
        const root = await snapshot(page);
        const rootId = await page.locator(".react-flow__node-compoundGroup").first().getAttribute("data-id");
        const header = page.locator(`.react-flow__node-compoundGroup:not([data-id=${JSON.stringify(rootId)}]) .compound-group-header`).first();
        await header.click({ force: true });
        await page.waitForFunction((id) => !document.querySelector(`.react-flow__node[data-id="${id}"]`), rootId);
        await settled(page);
        const profiler = process.env.BREADCRUMB_PROFILE === "1" ? await context.newCDPSession(page) : null;
        if (profiler !== null) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.start"); }
        await page.evaluate(() => {
          window.breadcrumbProof.requests = [];
          const crumb = document.querySelector('[aria-label="Map breadcrumbs"] button');
          if (!(crumb instanceof HTMLButtonElement)) throw new Error("Root breadcrumb missing.");
          window.breadcrumbProof.clickAt = performance.now();
          crumb.click();
        });
        await page.waitForFunction((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`), rootId);
        await settled(page);
        const elapsedMs = await page.evaluate(() => performance.now() - window.breadcrumbProof.clickAt);
        if (profiler !== null) {
          const { profile } = await profiler.send("Profiler.stop");
          writeFileSync(path.join(output, `profile-${side}-${run}.json`), JSON.stringify(profile));
        }
        const restored = await snapshot(page);
        if (JSON.stringify(restored.nodes) !== JSON.stringify(root.nodes) || restored.edges !== root.edges) {
          writeFileSync(path.join(output, `graph-mismatch-${side}-${run}.json`), JSON.stringify({ root, restored }, null, 2));
          throw new Error(`Breadcrumb graph changed: ${root.legend} -> ${restored.legend}`);
        }
        if (errors.length > 0) throw new Error(errors.join("\n"));
        const workerRequests = await page.evaluate(() => window.breadcrumbProof.requests);
        results.push({ side, run, elapsedMs, legend: restored.legend, blocks: restored.nodes.length, edges: restored.edges, errors: errors.length, workerRequests });
        writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
        if (run === runs - 1) await page.screenshot({ path: path.join(output, `side-${side}-root.png`) });
        console.log(JSON.stringify(results.at(-1)));
      } catch (error) {
        await page.screenshot({ path: path.join(output, `failure-${side}-${run}.png`) });
        writeFileSync(path.join(output, `failure-${side}-${run}.txt`), await page.locator("body").innerText());
        throw error;
      } finally {
        await context.close();
      }
    }
  }
  const summary = urls.map((_, side) => {
    const samples = results.filter((result) => result.side === side).map((result) => result.elapsedMs).sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    return { side, runs: samples.length, medianMs: samples.length % 2 === 0 ? (samples[middle - 1] + samples[middle]) / 2 : samples[middle], minMs: samples[0], maxMs: samples.at(-1) };
  });
  writeFileSync(path.join(output, "summary.json"), JSON.stringify({ browser: browser.version(), viewport: { width: 1440, height: 900 }, input: facts?.stats ?? "bundled Prismattyc", summary }, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}

async function settled(page) {
  await page.waitForFunction(() => {
    const requests = window.breadcrumbProof.requests;
    return requests.length === 0 || requests.at(-1).outcome === "layout-complete";
  }, null, { timeout: 30_000 });
  await page.getByLabel("Dependency chart legend").waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => new Promise((resolve, reject) => {
    let previous = "";
    let stable = 0;
    const deadline = performance.now() + 10_000;
    const check = () => {
      if (performance.now() > deadline) { reject(new Error("Map camera did not settle.")); return; }
      const transform = document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "";
      stable = transform === previous ? stable + 1 : 0;
      previous = transform;
      if (stable >= 5) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
}

async function snapshot(page) {
  return page.evaluate(() => ({
    nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => ({ id: node.getAttribute("data-id"), transform: node.style.transform })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: document.querySelectorAll(".react-flow__edge").length,
    legend: document.querySelector(".dependency-layout-stats")?.textContent,
  }));
}

function denseWorkspace() {
  const root = "workspace:dense";
  const group = "crate:dense";
  const ids = Array.from({ length: 800 }, (_, index) => `module:${index}`);
  const blocks = [
    { id: root, type: "workspace", label: "Dense workspace", parentId: null, children: [group], sourcePath: "Cargo.toml", memberCount: 1 },
    { id: group, type: "crate", label: "dense", parentId: root, children: ids, sourcePath: "src/lib.rs", packageName: "dense", version: "0.1.0", description: null },
    ...ids.map((id, index) => ({ id, type: "module", label: `module_${index}`, parentId: group, children: [], sourcePath: `src/module_${index}.rs`, packageName: "dense", modulePath: `module_${index}`, declaredByPath: "src/lib.rs", cfgAttributes: [], unresolved: false })),
  ].map((block) => ({ ...block, fingerprint: block.id }));
  const connections = [
    { id: "root-group", kind: "contains", source: root, target: group },
    ...ids.map((id) => ({ id: `contains:${id}`, kind: "contains", source: group, target: id })),
    ...ids.flatMap((id, index) => [1, 17].map((step) => ({ id: `dep:${index}:${step}`, kind: "depends_on", source: id, target: ids[(index + step) % ids.length], dependencyScope: "normal" }))),
  ];
  return { schemaVersion: 1, project: { id: root, name: "Dense workspace", rootPath: "." }, blocks, connections, groups: [], stats: { blocks: blocks.length, connections: connections.length, crates: 1, apps: 0, modules: ids.length, cargoFeatures: 0 } };
}
