#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [factsPath, repositoryPath, overlayPath] = process.argv.slice(2);
if (factsPath === undefined || repositoryPath === undefined || overlayPath === undefined) {
  throw new Error("Usage: node scripts/seed-annotations.mjs <facts.json> <repository> <overlay.json>");
}
if (existsSync(overlayPath)) throw new Error(`Refusing to overwrite existing annotation file: ${overlayPath}`);

const facts = JSON.parse(readFileSync(factsPath, "utf8"));
const manual = {
  "workspace:prismattyc": {
    description: "Prismattyc is a desktop terminal with session management, saved Spaces, and the pmux command line.",
    features: [
      { id: "feature:terminal-workspace", label: "Desktop terminal", description: "The windowed host renders terminal panes, keeps keyboard and theme settings, and organizes sessions in Spaces.", status: "ready", members: ["crate:prismattyc-host", "app:prismattyc-host:prismattyc-host", "crate:prismattyc-core", "crate:prismattyc-render", "crate:prismattyc-emulator", ["module", "prismattyc-host", "space_rail"], ["module", "prismattyc-host", "space_view"], ["module", "prismattyc-host", "theme"], ["module", "prismattyc-host", "keybind"], ["module", "prismattyc-host", "palette"]] },
      { id: "feature:session-control", label: "Session control", description: "The mux owns sessions, windows, panes, layout, and the local control protocol. The pmux tools manage sessions from scripts and terminals.", status: "ready", members: ["crate:prismattyc-mux", ["app", "prismattyc-mux", "pmux"], ["app", "prismattyc-mux", "pmuxd"], ["app", "prismattyc-mux", "pmux-attach"], ["module", "prismattyc-mux", "domain"], ["module", "prismattyc-mux", "layout_file"], ["module", "prismattyc-mux", "control"], ["module", "prismattyc-host", "mux"]] },
      { id: "feature:agent-mail", label: "Agent mail", description: "pmux stores local agent messages in the session server. The MCP adapter exposes mailbox actions to MCP clients.", status: "ready", members: ["crate:pmux-mcp", ["app", "pmux-mcp", "pmux-mcp"], ["module", "prismattyc-mux", "mailbox"], ["module", "prismattyc-mux", "attention"], ["module", "prismattyc-host", "session_prompt"]] },
      { id: "feature:remote-spaces", label: "Remote Spaces", description: "The host requests remote Space catalogs over SSH and shows remote destinations in its Space rail.", status: "ready", members: [["module", "prismattyc-host", "remote_catalog"], ["module", "prismattyc-host", "remote_rail"], ["module", "prismattyc-mux", "remote_catalog"], ["module", "prismattyc-mux", "remote_size"]] },
      { id: "feature:terminal-graphics", label: "Terminal graphics", description: "The emulator decodes and retains Kitty graphics payloads. The host has an optional GPU presentation path.", status: "ready", members: ["crate:prismattyc-emulator", "crate:prismattyc-protocol", ["module", "prismattyc-emulator", "graphics"], ["module", "prismattyc-protocol", "graphics_apc"], ["module", "prismattyc-host", "gpu"]] },
      { id: "feature:rich-sessions", label: "Rich sessions", description: "The host and mux contain experimental rich-session code, with a separate public client crate for the wire protocol.", status: "wip", members: ["crate:prismattyc-rich-client", ["module", "prismattyc-rich-client", "raw"], ["module", "prismattyc-host", "rich"], ["module", "prismattyc-mux", "rich"]] },
      { id: "feature:browser-labs", label: "Browser lab", description: "The WebAssembly lab is a proof of concept with in-memory agent mail and a browser surface.", status: "wip", members: ["crate:prismattyc-labs", ["module", "prismattyc-labs", "mailbox"], ["module", "prismattyc-labs", "wasm_lab"]] },
    ],
    groups: [
      { id: "group:desktop", label: "Desktop", featureIds: ["feature:terminal-workspace", "feature:remote-spaces"] },
      { id: "group:sessions", label: "Sessions", featureIds: ["feature:session-control", "feature:agent-mail"] },
      { id: "group:terminal", label: "Terminal", featureIds: ["feature:terminal-graphics", "feature:rich-sessions"] },
      { id: "group:lab", label: "Lab", featureIds: ["feature:browser-labs"] },
    ],
  },
  "workspace:scorecard": {
    description: "Scorecard is a local code-quality gate that runs project checks and reports results for people, agents, and CI.",
    features: [
      { id: "feature:quality-gate", label: "Quality gate", description: "The sc command assembles engine findings into a scorecard with enforced and advisory gates.", status: "ready", members: ["crate:sc-cli", "app:sc-cli:sc", "crate:sc-core", "crate:sc-engines", ["module", "sc-engines", "pipeline"], ["module", "sc-cli", "report"], ["module", "sc-cli", "pretty"]] },
      { id: "feature:source-analysis", label: "Source analysis", description: "Source discovery, imports, public items, and complexity analysis feed the project facts used by the engines.", status: "ready", members: ["crate:sc-graph", ["module", "sc-graph", "discover"], ["module", "sc-graph", "imports"], ["module", "sc-graph", "pubs"], ["module", "sc-graph", "complexity"], ["module", "sc-engines", "facts"]] },
      { id: "feature:test-coverage", label: "Tests and coverage", description: "The engines run project tests, collect line coverage, and compare coverage with function complexity.", status: "ready", members: [["module", "sc-engines", "cargo_test"], ["module", "sc-engines", "coverage"], ["module", "sc-engines", "crap"], ["module", "sc-engines", "compile"]] },
      { id: "feature:security-checks", label: "Security checks", description: "The secrets engine scans project files for supported credential patterns and reports findings through the scorecard.", status: "ready", members: [["module", "sc-engines", "secrets"], ["module", "sc-engines", "scope"], ["module", "sc-engines", "manifest"]] },
      { id: "feature:language-packs", label: "Language packs", description: "Pack detection selects language-specific compile, test, coverage, and lint commands for supported project types.", status: "ready", members: [["module", "sc-engines", "pack"], ["module", "sc-engines", "python"], ["module", "sc-engines", "toolchain"], ["module", "sc-engines", "poly_cc"]] },
      { id: "feature:reports-integrations", label: "Reports and integrations", description: "Scorecards can be rendered as terminal, HTML, Markdown, JSON, or SARIF output. The MCP server exposes analysis tools.", status: "ready", members: ["crate:sc-sarif", ["module", "sc-sarif", "crate root"], ["module", "sc-cli", "format"], ["module", "sc-cli", "report"], "crate:sc-mcp", ["app", "sc-mcp", "sc-mcp"], ["module", "sc-mcp", "crate root"]] },
      { id: "feature:spec-review", label: "Spec review", description: "An optional OpenAI-compatible review checks requirement coverage and reports possible specification gaps.", status: "ready", members: ["crate:sc-llm", ["module", "sc-llm", "crate root"], ["module", "sc-engines", "spec_check"]] },
      { id: "feature:mutation-check", label: "Mutation checks", description: "The mutation engine changes code in controlled ways and checks whether the project's tests detect those changes.", status: "ready", members: ["crate:sc-mutation", ["module", "sc-engines", "mutation"]] },
    ],
    groups: [
      { id: "group:quality", label: "Quality", featureIds: ["feature:quality-gate", "feature:source-analysis"] },
      { id: "group:verification", label: "Verification", featureIds: ["feature:test-coverage", "feature:mutation-check"] },
      { id: "group:security", label: "Security", featureIds: ["feature:security-checks"] },
      { id: "group:output", label: "Output", featureIds: ["feature:reports-integrations", "feature:spec-review", "feature:language-packs"] },
    ],
  },
};

const overrides = {
  "prismattyc-emulator|crate root::graphics": "Retains Kitty graphics images and placements for each terminal screen. It validates image sizes, tracks cell anchors, and applies upload commands.",
  "prismattyc-mux|crate root::mailbox::agent_id": "Defines stable agent IDs for pmux mailboxes and validates their accepted form.",
  "sc-cli|crate root::format": "Formats scorecards as JSON and Markdown, including their findings and project summary.",
  "sc-engines|crate root::cargo_test": "Runs Cargo tests and turns process results into scorecard findings. It also selects targeted Rust tests when the project supports them.",
  "sc-engines|crate root::command": "Runs external commands with time limits and captures their output and failure details.",
  "sc-engines|crate root::compile": "Runs project compilation and maps compiler diagnostics into scorecard findings.",
  "sc-engines|crate root::crap": "Compares function complexity with measured test coverage and reports CRAP scores.",
  "sc-engines|crate root::facts": "Collects project source facts and cache keys for repeatable engine runs.",
  "sc-engines|crate root::manifest": "Reads package manifests to resolve workspace ownership and declared dependencies.",
  "sc-engines|crate root::mutation": "Runs mutation checks and summarizes which source changes the project's tests detected.",
  "sc-engines|crate root::scope": "Selects the files and packages included in an analysis run according to project scope rules.",
  "sc-engines|crate root::secrets": "Scans project text for supported credential patterns and emits security findings.",
  "sc-engines|crate root::spec_check": "Compares stated requirements with source and file evidence to report possible specification gaps.",
  "sc-graph|crate root::complexity": "Parses Rust items and calculates cyclomatic complexity for functions and closures.",
  "sc-graph|crate root::discover": "Walks project files to find source code while applying ignore, generated-file, and scope rules.",
  "sc-graph|crate root::imports": "Reads source import paths and local names for dependency checks.",
  "sc-graph|crate root::pubs": "Collects public item declarations from Rust source files.",
};

function moduleDescription(block) {
  const key = `${block.packageName}|${block.modulePath}`;
  if (overrides[key] !== undefined) return overrides[key];
  if (block.sourcePath === null) return `Declares the ${block.label} module, but its source file is not present at the declared path.`;
  const source = readFileSync(path.join(repositoryPath, block.sourcePath), "utf8");
  const lines = source.split(/\r?\n/);
  const innerStart = lines.findIndex((line) => /^\s*\/\/!/.test(line));
  const outerStart = innerStart < 0 ? lines.findIndex((line) => /^\s*\/\/\//.test(line)) : -1;
  const marker = innerStart >= 0 ? "//!" : "///";
  const start = innerStart >= 0 ? innerStart : outerStart;
  const docs = [];
  if (start >= 0) {
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "" && lines[index + 1]?.trim().startsWith(marker)) {
        docs.push("");
        continue;
      }
      const trimmed = line.trimStart();
      if (!trimmed.startsWith(marker)) break;
      docs.push(trimmed.slice(marker.length).replace(/^\s?/, ""));
    }
  }
  const paragraph = docs.join(" ").replace(/\s+/g, " ").trim()
    .split(/(?<=[.!?])\s+(?=[A-Z`])/)
    .slice(0, 3)
    .join(" ");
  if (paragraph.length > 0) return paragraph;
  throw new Error(`Module needs a written description: ${key}`);
}

const selected = manual[facts.project.id];
if (selected === undefined) throw new Error(`No annotation plan for ${facts.project.id}`);
const packageDescriptions = {
  "prismattyc-core": "Shared classic-terminal screen model used by the renderer and host.",
  "prismattyc": "Command-line entry point for running the Prismattyc terminal renderer.",
  "prismattyc-emulator": "Parses terminal escape sequences and integrates terminal screens with child processes.",
  "prismattyc-render": "Renders terminal cells into pixels for the desktop host and terminal client.",
  "prismattyc-protocol": "Defines bounded control and graphics protocol types shared across Prismattyc components.",
  "prismattyc-mux": "Owns pmux sessions, windows, panes, layouts, and the background session server.",
  "prismattyc-host": "Runs Prismattyc in its own desktop window and connects the terminal UI to the session mux.",
  "prismattyc-labs": "Browser labs proof of concept with in-memory agent mail and a WebAssembly surface.",
  "prismattyc-rich-client": "Public client for the Prismattyc rich-session wire protocol.",
  "pmux-mcp": "MCP stdio adapter over the pmux mailbox control socket.",
};
const appDescriptions = {
  "prismattyc:prismattyc": "Runs the terminal renderer inside an existing terminal.",
  "prismattyc-host:prismattyc-host": "Opens the windowed Prismattyc terminal application.",
  "prismattyc-mux:pmux": "Manages Prismattyc sessions from a terminal or script.",
  "prismattyc-mux:pmux-attach": "Connects an existing terminal to a pmux session.",
  "prismattyc-mux:pmuxd": "Keeps pmux sessions running in the background.",
  "pmux-mcp:pmux-mcp": "Exposes pmux session and mail actions through MCP over stdio.",
  "sc-cli:sc": "Runs Scorecard analysis and prints a human-readable or machine-readable report.",
  "sc-mcp:sc-mcp": "Exposes Scorecard analysis tools through an MCP server.",
};
const featureDescriptions = {
  "prismattyc-host:default": "Enables the default compile-time feature set declared for the windowed host.",
  "prismattyc-host:gpu": "Enables the optional wgpu presentation path for the windowed host.",
  "sc-cli:default": "Uses the default compile-time feature set declared for the sc command.",
};
const wipPackages = new Set(["prismattyc-labs", "prismattyc-rich-client"]);

const blockAnnotations = {};
for (const block of facts.blocks) {
  let kind = "MODULE";
  let description;
  let status = "ready";
  if (block.type === "workspace") {
    kind = "APP";
    description = selected.description;
  } else if (block.type === "crate") {
    kind = "CRATE";
    description = block.description || packageDescriptions[block.packageName];
    if (wipPackages.has(block.packageName)) status = "wip";
  } else if (block.type === "app") {
    kind = "APP";
    description = appDescriptions[`${block.packageName}:${block.targetName}`];
  } else if (block.type === "cargo_feature") {
    kind = "FEATURE";
    description = featureDescriptions[`${block.packageName}:${block.featureName}`];
  } else if (block.type === "module") {
    description = moduleDescription(block);
    if (wipPackages.has(block.packageName) || (block.modulePath.endsWith("::rich") && block.packageName === "prismattyc-host")) status = "wip";
  }
  if (description === undefined || description.length === 0) throw new Error(`Block needs a written description: ${block.id}`);
  blockAnnotations[block.id] = {
    description,
    kind,
    status,
    sourceFingerprint: block.fingerprint,
  };
}

const ids = facts.blocks.map((block) => block.id);
function resolveMember(reference) {
  if (typeof reference === "string") {
    if (!ids.includes(reference)) throw new Error(`Unknown feature member ${reference}`);
    return reference;
  }
  const [type, packageName, value] = reference;
  const matches = facts.blocks.filter((block) => {
    if (block.packageName !== packageName) return false;
    if (type === "app") return block.type === "app" && block.targetName === value;
    if (type === "module") return block.type === "module" && block.modulePath.split("::").at(-1) === value;
    return false;
  });
  if (matches.length !== 1) throw new Error(`Expected one feature member for ${JSON.stringify(reference)}, found ${matches.length}`);
  const match = matches[0];
  if (match === undefined) throw new Error(`Could not resolve feature member ${JSON.stringify(reference)}`);
  return match.id;
}

const features = selected.features.map((feature) => {
  const memberIds = [...new Set(feature.members.map(resolveMember))];
  const sourceFingerprints = Object.fromEntries(memberIds.map((id) => {
    const block = facts.blocks.find((candidate) => candidate.id === id);
    if (block === undefined) throw new Error(`Missing feature source block ${id}`);
    return [id, block.fingerprint];
  }));
  return {
    id: feature.id,
    label: feature.label,
    description: feature.description,
    kind: "FEATURE",
    status: feature.status,
    memberIds,
    sourceFingerprints,
    pathLabel: `${memberIds.length} linked code blocks`,
  };
});

const overlay = {
  schemaVersion: 1,
  projectId: facts.project.id,
  blocks: blockAnnotations,
  features,
  groups: selected.groups,
};
mkdirSync(path.dirname(overlayPath), { recursive: true });
writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
console.log(`Wrote ${Object.keys(blockAnnotations).length} block annotations and ${features.length} feature annotations.`);
