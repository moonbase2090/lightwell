import { test, expect, gotoIpc } from "./helpers.js";

// A workspace with 150 crates of 14 modules each and 8,000 dependencies between random modules.
// Routing that many edges is slow, so the Modules view has to fall back to a smaller layout.
function heavyWorkspace() {
  const root = "workspace:heavy";
  const groups = 150;
  const perGroup = 14;
  const fingerprint = "0".repeat(64);
  const blocks: Record<string, unknown>[] = [
    { type: "workspace", id: root, label: "heavy-workspace", parentId: null, children: [], sourcePath: "Cargo.toml", fingerprint, memberCount: groups },
  ];
  const connections: Record<string, unknown>[] = [];
  const modules: string[] = [];
  const rootChildren: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    const crateId = `crate:svc-${group}`;
    const children: string[] = [];
    blocks.push({
      type: "crate", id: crateId, label: `svc-${group}`, parentId: root, children,
      sourcePath: `crates/svc-${group}/Cargo.toml`, fingerprint, packageName: `svc-${group}`, version: "0.1.0", description: null,
    });
    rootChildren.push(crateId);
    connections.push({ kind: "contains", id: `contains:${root}->${crateId}`, source: root, target: crateId });
    for (let index = 0; index < perGroup; index += 1) {
      const moduleId = `module:svc-${group}:m${index}`;
      blocks.push({
        type: "module", id: moduleId, label: `m${index}`, parentId: crateId, children: [],
        sourcePath: `crates/svc-${group}/src/m${index}.rs`, fingerprint, packageName: `svc-${group}`, modulePath: `m${index}`,
        declaredByPath: `crates/svc-${group}/src/lib.rs`, cfgAttributes: [], unresolved: false,
      });
      children.push(moduleId);
      modules.push(moduleId);
      connections.push({ kind: "contains", id: `contains:${crateId}->${moduleId}`, source: crateId, target: moduleId });
    }
  }
  (blocks[0] as { children: string[] }).children = rootChildren;
  for (let index = 0; index < 8_000; index += 1) {
    const source = modules[(index * 37) % modules.length]!;
    const target = modules[(index * 91 + 13 + Math.floor(index / modules.length)) % modules.length]!;
    if (source === target) continue;
    connections.push({ kind: "depends_on", id: `depends_on:${index}`, source, target, dependencyScope: "normal" });
  }
  const facts = {
    schemaVersion: 1,
    project: { id: root, name: "heavy-workspace", rootPath: "." },
    blocks,
    connections,
    groups: [],
    stats: { blocks: blocks.length, connections: connections.length, crates: groups, apps: 0, modules: modules.length, cargoFeatures: 0 },
  };
  return { id: root, facts, blockCount: blocks.length };
}

test("MOD-01: the Modules view lays out a dependency-heavy workspace at Depth All without an error", async ({ page }) => {
  test.setTimeout(60_000);
  const { id, facts, blockCount } = heavyWorkspace();
  await gotoIpc(page, {
    workspaces: [{ id, label: "heavy-workspace" }],
    maps: {
      [id]: {
        facts,
        annotations: { schemaVersion: 1, projectId: id, blocks: {}, features: [], groups: [] },
        projectNotes: { kind: "ready", notes: [] },
      },
    },
  }, "modules");
  await page.getByLabel("Map depth").selectOption("all");

  const stats = page.locator(".dependency-layout-stats");
  await expect(stats).toContainText(new RegExp(`/${blockCount} blocks`), { timeout: 30_000 });
  await expect(stats).toContainText("dependencies hidden");
  await expect(page.locator(".graph-message[role=alert]")).toHaveCount(0);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
