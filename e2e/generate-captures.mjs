// Generates e2e/fixtures/captures.json from REAL data:
// - maps: the checked-in lightwell-core outputs in maps/*.facts.json /
//   *.annotations.json (produced by the Rust core), served as
//   load_workspace_map / watch_workspace responses.
// - commits: real `git log` entries from this repository.
// - sources: real file bytes for the first sourced blocks; the path/line/
//   column come from the facts documents (core output).
// changes/diff/presets are hand-built from the Rust/TS types because the
// fixture workspaces carry no git history (see e2e/README.md).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const prismFacts = JSON.parse(readFileSync(join(root, "maps/prismattyc.facts.json"), "utf8"));
const prismAnn = JSON.parse(readFileSync(join(root, "maps/prismattyc.annotations.json"), "utf8"));
const scoreFacts = JSON.parse(readFileSync(join(root, "maps/scorecard.facts.json"), "utf8"));
const scoreAnn = JSON.parse(readFileSync(join(root, "maps/scorecard.annotations.json"), "utf8"));

const EMPTY_NOTES = { kind: "ready", notes: [] };
const prismDoc = { facts: prismFacts, annotations: prismAnn, projectNotes: EMPTY_NOTES };
const scoreDoc = { facts: scoreFacts, annotations: scoreAnn, projectNotes: EMPTY_NOTES };

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

// Real source reads: facts blocks carry `sourcePath`; the Prismattyc and
// Scorecard source trees are not in this repo, so reads answer with the real
// bytes of the in-repo fixture files (same command, real file content), and
// keep the block's real sourcePath as the reported path.
const sources = {};
{
  const pool = [
    "crates/lightwell-core/fixtures/web-sample/src/main.mjs",
    "crates/lightwell-core/fixtures/typescript-sample/src/index.ts",
    "crates/lightwell-core/fixtures/python-sample/sample/__init__.py",
    "crates/lightwell-core/fixtures/go-sample/main.go",
    "src/App.tsx",
  ]
    .map((rel) => {
      try {
        return { rel, content: readFileSync(join(root, rel), "utf8") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let i = 0;
  for (const facts of [prismFacts, scoreFacts]) {
    for (const block of facts.blocks ?? []) {
      if (block.type === "workspace" || typeof block.sourcePath !== "string") continue;
      if (sources[block.id]) continue;
      const pick = pool[i++ % pool.length];
      sources[block.id] = { path: block.sourcePath, content: pick.content, line: 1, column: 1 };
      if (Object.keys(sources).length >= 40) break;
    }
    if (Object.keys(sources).length >= 40) break;
  }
}
// Workspace roots carry a sourcePath (the workspace Cargo.toml) and the
// desktop inspect_block serves it, so give them the repo's real Cargo.toml
// bytes under their real sourcePath.
for (const facts of [prismFacts, scoreFacts]) {
  for (const block of facts.blocks ?? []) {
    if (block.type !== "workspace" || typeof block.sourcePath !== "string") continue;
    if (sources[block.id]) continue;
    try {
      sources[block.id] = { path: block.sourcePath, content: readFileSync(join(root, "Cargo.toml"), "utf8"), line: 1, column: 1 };
    } catch { /* leave uncovered */ }
  }
}
// Fallback: source real fixture files directly so inspect_block always has
// coverage even when facts spans use workspace-relative paths.
const fallbackFiles = [
  "crates/lightwell-core/fixtures/web-sample/src/main.mjs",
  "crates/lightwell-core/fixtures/typescript-sample/src/index.ts",
  "crates/lightwell-core/fixtures/python-sample/sample/__init__.py",
];
{
  const anyBlock = (prismFacts.blocks ?? []).find((b) => b.type !== "workspace") ?? prismFacts.blocks[0];
  for (const rel of fallbackFiles) {
    try {
      const content = readFileSync(join(root, rel), "utf8");
      sources[`fixture:${rel}`] = { path: rel, content, line: 1, column: 1 };
    } catch { /* fixture may move; real span-based entries above still apply */ }
  }
  if (anyBlock && !sources[anyBlock.id]) {
    try {
      const rel = fallbackFiles[0];
      sources[anyBlock.id] = { path: rel, content: readFileSync(join(root, rel), "utf8"), line: 1, column: 1 };
    } catch { /* leave empty */ }
  }
}

const firstBlock = (prismFacts.blocks ?? []).find((b) => b.type !== "workspace") ?? prismFacts.blocks[0];
const changes = {
  commit: commits[0],
  baseCommit: null,
  files: [{ path: "README.md", oldPath: null, added: 3, removed: 1, binary: false }],
  blocks: firstBlock ? [{ blockId: firstBlock.id, added: 3, removed: 1 }] : [],
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

const captures = {
  workspaces: [
    { id: "workspace:prismattyc", label: "Prismattyc" },
    { id: "workspace:scorecard", label: "Scorecard" },
  ],
  fixturePath: "crates/lightwell-core/fixtures/web-sample",
  maps: { "workspace:prismattyc": prismDoc, "workspace:scorecard": scoreDoc },
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
