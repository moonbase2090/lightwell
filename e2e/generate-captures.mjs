// Generates e2e/fixtures/captures.json as a MINIMAL sanitized fixture.
//
// Sources (per e2e/README.md capture rules, real lightwell-core data only):
// - maps: a 4-block subset (workspace root + one crate + one app + one
//   module) of the checked-in lightwell-core outputs in
//   maps/*.facts.json. Structure, fingerprints, versions, kinds, statuses,
//   and parentage mirror the real documents; everything else is scrubbed:
//   free-text descriptions are dropped, and all path / package / target /
//   module identifiers point at in-repo fixture files instead of the
//   scanned product trees. Annotation overlays are empty (the app renders
//   blocks without annotations as "No description is written yet").
// - commits: real `git log` entries from this repository.
// - sources: real bytes of in-repo fixture files, keyed by every retained
//   block id so inspect_block always resolves.
// changes/diff/presets are hand-built from the Rust/TS types because the
// fixture workspaces carry no git history (see e2e/README.md).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (rel) => readFileSync(join(root, rel), "utf8");

// Each capture workspace keeps the real workspace root plus one crate, one
// app, and one module. `sourceRel` is a real in-repo fixture file whose bytes
// back every retained block; `names` are neutral identifiers derived from
// that fixture file, never from the scanned product trees.
const WORKSPACES = [
  {
    factsRel: "maps/prismattyc.facts.json",
    annotationsRel: "maps/prismattyc.annotations.json",
    sourceRel: "crates/lightwell-core/fixtures/web-sample/src/main.mjs",
    crateId: "crate:web-sample",
    crateLabel: "web-sample",
    appId: "app:web-sample:main",
    appLabel: "main",
    moduleId: "module:web-sample:main",
    moduleLabel: "main",
    moduleParent: "app",
  },
  {
    factsRel: "maps/scorecard.facts.json",
    annotationsRel: "maps/scorecard.annotations.json",
    sourceRel: "crates/lightwell-core/fixtures/typescript-sample/lib.ts",
    crateId: "crate:typescript-sample",
    crateLabel: "typescript-sample",
    appId: "app:typescript-sample:lib",
    appLabel: "lib",
    moduleId: "module:typescript-sample:lib",
    moduleLabel: "lib",
    moduleParent: "crate",
  },
];

function firstChildOfType(byId, parent, type) {
  const child = (parent.children ?? []).map((id) => byId[id]).find((b) => b?.type === type);
  if (!child) throw new Error(`no ${type} child under ${parent.id}`);
  return child;
}

function buildDoc(spec) {
  const facts = JSON.parse(read(spec.factsRel));
  const annotations = JSON.parse(read(spec.annotationsRel));
  const byId = Object.fromEntries(facts.blocks.map((b) => [b.id, b]));
  const rootBlock = facts.blocks.find((b) => b.type === "workspace");
  if (!rootBlock) throw new Error(`no workspace block in ${spec.factsRel}`);
  const crateTemplate = firstChildOfType(byId, rootBlock, "crate");
  const appTemplate = firstChildOfType(byId, crateTemplate, "app");
  const moduleTemplate = (appTemplate.children ?? []).map((id) => byId[id]).find((b) => b?.type === "module")
    ?? firstChildOfType(byId, crateTemplate, "module");
  const sourceContent = read(spec.sourceRel);

  const root = { ...rootBlock, children: [spec.crateId], memberCount: 1 };
  const crate = {
    ...crateTemplate,
    id: spec.crateId,
    label: spec.crateLabel,
    parentId: root.id,
    children: spec.moduleParent === "crate" ? [spec.appId, spec.moduleId] : [spec.appId],
    sourcePath: spec.sourceRel,
    packageName: spec.crateLabel,
    description: null,
  };
  const app = {
    ...appTemplate,
    id: spec.appId,
    label: spec.appLabel,
    parentId: spec.crateId,
    children: spec.moduleParent === "app" ? [spec.moduleId] : [],
    sourcePath: spec.sourceRel,
    packageName: spec.crateLabel,
    targetName: spec.appLabel,
    entryPath: spec.sourceRel,
  };
  const module = {
    ...moduleTemplate,
    id: spec.moduleId,
    label: spec.moduleLabel,
    parentId: spec.moduleParent === "app" ? spec.appId : spec.crateId,
    children: [],
    sourcePath: spec.sourceRel,
    packageName: spec.crateLabel,
    modulePath: spec.appLabel,
    declaredByPath: spec.sourceRel,
  };
  delete module.language;
  const blocks = [root, crate, app, module];
  const kept = new Set(blocks.map((b) => b.id));
  const remap = new Map([
    [rootBlock.id, root.id],
    [crateTemplate.id, crate.id],
    [appTemplate.id, app.id],
    [moduleTemplate.id, module.id],
  ]);
  // Keep only real edges whose endpoints survive, remapped to the new ids.
  const connections = (facts.connections ?? [])
    .filter((c) => remap.has(c.source) && remap.has(c.target))
    .map((c) => ({ ...c, source: remap.get(c.source), target: remap.get(c.target) }))
    .map((c) => ({ ...c, id: `${c.kind}:${c.source}->${c.target}` }));
  const doc = {
    facts: {
      schemaVersion: 1,
      project: { ...facts.project },
      blocks,
      connections,
      groups: [],
      stats: {
        blocks: blocks.length,
        connections: connections.length,
        crates: 1,
        apps: 1,
        modules: 1,
        cargoFeatures: 0,
      },
    },
    // Sanitized overlay: no block/feature descriptions from the scanned
    // trees. projectId must match facts.project.id (see resolveMap).
    annotations: {
      schemaVersion: 1,
      projectId: annotations.projectId,
      blocks: {},
      features: [],
      groups: [],
    },
    projectNotes: { kind: "ready", notes: [] },
  };
  if (doc.facts.project.id !== doc.annotations.projectId) {
    throw new Error(`project mismatch in ${spec.factsRel}`);
  }
  const cargoContent = read("Cargo.toml");
  const sources = {};
  for (const block of blocks) {
    const isRoot = block.id === root.id;
    sources[block.id] = {
      path: isRoot ? "Cargo.toml" : spec.sourceRel,
      content: isRoot ? cargoContent : sourceContent,
      line: 1,
      column: 1,
    };
  }
  return { doc, sources, rootId: root.id, appId: app.id };
}

const built = WORKSPACES.map(buildDoc);

const commits = execFileSync("git", ["log", "--format=%H%x09%h%x09%s%x09%at", "-8"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .map((line) => {
    const [id, shortId, summary, ts] = line.split("\t");
    return { id, shortId, summary, timestamp: Number(ts) };
  });

const changes = {
  commit: commits[0],
  baseCommit: null,
  files: [{ path: "README.md", oldPath: null, added: 3, removed: 1, binary: false }],
  blocks: [{ blockId: built[0].appId, added: 3, removed: 1 }],
  connections: [],
};
const diff = {
  commit: commits[0],
  path: "README.md",
  originalPath: null,
  original: "# Lightwell\n\nOld line.\n",
  modified: "# Lightwell\n\nNew line.\n",
  line: 1,
};

const sources = Object.assign({}, ...built.map((b) => b.sources));
const captures = {
  workspaces: [
    { id: "workspace:prismattyc", label: "Prismattyc" },
    { id: "workspace:scorecard", label: "Scorecard" },
  ],
  fixturePath: "crates/lightwell-core/fixtures/web-sample",
  maps: {
    "workspace:prismattyc": built[0].doc,
    "workspace:scorecard": built[1].doc,
  },
  sources,
  commits,
  changes,
  diff,
  // Shape follows parseEditorTemplatePresets: { name, template }.
  presets: [
    { name: "Visual Studio Code", template: "code -g {file}:{line}:{column}" },
    { name: "Zed", template: "zed {file}:{line}:{column}" },
  ],
};

writeFileSync(join(root, "e2e/fixtures/captures.json"), `${JSON.stringify(captures, null, 1)}\n`);
console.log(`wrote captures: ${commits.length} commits, ${Object.keys(sources).length} sources`);
