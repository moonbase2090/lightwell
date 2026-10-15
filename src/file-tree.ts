import type { DisplayBlock, FactConnection } from "./model.js";

export type MapView = "modules" | "files";

export interface MapViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FileTreeSource {
  readonly id: string;
  readonly label: string;
  readonly sourcePath: string | null;
  readonly parentId: string | null;
  readonly children: readonly string[];
}

export interface FileTreeNode {
  readonly id: string;
  readonly label: string;
  readonly sourcePath: string | null;
  readonly children: readonly string[];
  /** Mapped block id when this node is a block. Null for a folder. */
  readonly blockId: string | null;
  readonly folder: boolean;
  readonly parentId: string | null;
}

export interface FileTree {
  readonly rootId: string;
  readonly nodes: readonly FileTreeNode[];
  readonly nodeById: ReadonlyMap<string, FileTreeNode>;
  readonly parentOf: (id: string) => string | null;
}

export interface DirEntry {
  readonly name: string;
  readonly directory: boolean;
}

const BUILD_DIRECTORIES = new Set(["target", "node_modules", "dist"]);

export function mapViewStorageKey(workspaceId: string): string {
  return `lightwell.map-view.v1:${encodeURIComponent(workspaceId)}`;
}

export function parseMapView(value: string | null): MapView {
  return value === "files" ? "files" : "modules";
}

export function readMapView(storage: MapViewStorage | null, workspaceId: string): MapView {
  if (storage === null) return "modules";
  try {
    return parseMapView(storage.getItem(mapViewStorageKey(workspaceId)));
  } catch {
    return "modules";
  }
}

export function writeMapView(storage: MapViewStorage | null, workspaceId: string, view: MapView): void {
  if (storage === null) return;
  try {
    storage.setItem(mapViewStorageKey(workspaceId), view);
  } catch {
    // The map still uses the chosen view for this session.
  }
}

export function folderNodeId(repoRelativeDir: string): string {
  return `dir:${encodeURIComponent(repoRelativeDir)}`;
}

export function folderPathFromId(id: string): string | null {
  if (!id.startsWith("dir:")) return null;
  try {
    return decodeURIComponent(id.slice(4));
  } catch {
    return null;
  }
}

/** Directory that contains a block file. A workspace Cargo.toml lives at the repo root. */
export function scopeDirectory(sourcePath: string | null): string {
  const path = normalizeRepoPath(sourcePath);
  if (path === null || path === "") return "";
  return parentDirectory(path);
}

/**
 * Directory to open so `sourcePath` is a direct child of the file-tree root.
 * Empty means the current scope block stays the root.
 */
export function fileScopeForBlock(sourcePath: string | null, scopeDir: string): string {
  const path = normalizeRepoPath(sourcePath);
  if (path === null || path === "") return "";
  const parent = parentDirectory(path);
  if (parent === scopeDir) return "";
  if (scopeDir !== "" && parent !== scopeDir && !parent.startsWith(`${scopeDir}/`)) return "";
  return parent;
}

export function fileScopeCrumbs(fileScope: string, scopeDir: string): readonly string[] {
  if (fileScope === "" || fileScope === scopeDir) return [];
  const relative = scopeDir !== "" && fileScope.startsWith(`${scopeDir}/`)
    ? fileScope.slice(scopeDir.length + 1)
    : fileScope;
  return relative.split("/").filter((part) => part.length > 0);
}

export function parseGitignore(text: string): readonly string[] {
  const rules: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    rules.push(trimmed);
  }
  return rules;
}

/** True for build output and for a path the gitignore rules exclude. Later rules win, except build directories stay out. */
export function isIgnoredRepoPath(repoPath: string, rules: readonly string[]): boolean {
  const normalized = normalizeRepoPath(repoPath);
  if (normalized === null || normalized === "") return false;
  if (normalized.split("/").some((part) => BUILD_DIRECTORIES.has(part))) return true;
  let ignored = false;
  for (const rule of rules) {
    const matched = ruleEffect(rule, normalized);
    if (matched !== null) ignored = matched;
  }
  return ignored;
}

export function collectRepoFiles(
  listDir: (relativeDir: string) => readonly DirEntry[],
  rules: readonly string[],
): string[] {
  const files: string[] = [];
  const pending = [""];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    let entries: readonly DirEntry[];
    try {
      entries = listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (isIgnoredRepoPath(path, rules)) continue;
      if (entry.directory) pending.push(path);
      else files.push(path);
    }
  }
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return files;
}

export function buildFileTree(
  scope: FileTreeSource,
  blockById: ReadonlyMap<string, FileTreeSource>,
  rules: readonly string[] = [],
): FileTree {
  const nodes = new Map<string, MutableNode>();
  const scopePath = normalizeRepoPath(scope.sourcePath);
  const scopeDir = scopeDirectory(scope.sourcePath);
  nodes.set(scope.id, {
    id: scope.id,
    label: scope.label,
    sourcePath: scopePath,
    children: [],
    blockId: scope.id,
    folder: false,
    parentId: null,
  });

  for (const block of descendants(scope, blockById)) {
    if (block.id === scope.id) continue;
    const path = normalizeRepoPath(block.sourcePath);
    if (path !== null && isIgnoredRepoPath(path, rules)) continue;
    if (path === null) {
      link(nodes, folderForBlock(nodes, block, blockById, scope.id, scopeDir), block.id, leaf(block, path));
      continue;
    }
    const relative = relativeTo(path, scopeDir);
    if (relative === null || relative === "") {
      link(nodes, scope.id, block.id, leaf(block, path));
      continue;
    }
    const parts = relative.split("/");
    let parentId = scope.id;
    let repoDir = scopeDir;
    for (const part of parts.slice(0, -1)) {
      repoDir = repoDir === "" ? part : `${repoDir}/${part}`;
      const folder = ensureFolder(nodes, repoDir);
      link(nodes, parentId, folder.id, folder);
      parentId = folder.id;
    }
    link(nodes, parentId, block.id, leaf(block, path));
  }

  for (const node of nodes.values()) {
    node.children.sort((left, right) => compareChild(nodes.get(left), nodes.get(right), left, right));
  }

  const frozen = new Map<string, FileTreeNode>();
  for (const node of nodes.values()) {
    frozen.set(node.id, {
      id: node.id,
      label: node.label,
      sourcePath: node.sourcePath,
      children: node.children,
      blockId: node.blockId,
      folder: node.folder,
      parentId: node.parentId,
    });
  }
  return {
    rootId: scope.id,
    nodes: [...frozen.values()],
    nodeById: frozen,
    parentOf(id: string): string | null {
      return frozen.get(id)?.parentId ?? null;
    },
  };
}

export function fileTreeContainsEdges(tree: FileTree): FactConnection[] {
  const edges: FactConnection[] = [];
  for (const node of tree.nodes) {
    if (node.parentId === null) continue;
    edges.push({
      id: `file-tree:${node.parentId}:${node.id}`,
      source: node.parentId,
      target: node.id,
      kind: "contains",
    });
  }
  return edges;
}

export function fileTreeDisplayBlock(
  node: FileTreeNode,
  blockById: ReadonlyMap<string, DisplayBlock>,
): DisplayBlock | null {
  if (node.folder || node.blockId === null) return folderDisplay(node);
  const block = blockById.get(node.blockId);
  if (block === undefined) return null;
  if (sameIds(block.children, node.children)) return block;
  return { ...block, children: node.children };
}

export function rollupAlongParents(
  direct: ReadonlyMap<string, { readonly added: number; readonly removed: number }>,
  parentOf: (id: string) => string | null,
): Map<string, { added: number; removed: number; direct: boolean }> {
  const result = new Map<string, { added: number; removed: number; direct: boolean }>();
  for (const [id, change] of direct) {
    result.set(id, { added: change.added, removed: change.removed, direct: true });
  }
  for (const [id, change] of direct) {
    let ancestor = parentOf(id);
    while (ancestor !== null && !direct.has(ancestor)) {
      const entry = result.get(ancestor) ?? { added: 0, removed: 0, direct: false };
      entry.added += change.added;
      entry.removed += change.removed;
      result.set(ancestor, entry);
      ancestor = parentOf(ancestor);
    }
  }
  return result;
}

interface MutableNode {
  id: string;
  label: string;
  sourcePath: string | null;
  children: string[];
  blockId: string | null;
  folder: boolean;
  parentId: string | null;
}

function leaf(block: FileTreeSource, sourcePath: string | null): MutableNode {
  return {
    id: block.id,
    label: block.label,
    sourcePath,
    children: [],
    blockId: block.id,
    folder: false,
    parentId: null,
  };
}

function ensureFolder(nodes: Map<string, MutableNode>, repoDir: string): MutableNode {
  const id = folderNodeId(repoDir);
  const existing = nodes.get(id);
  if (existing !== undefined) return existing;
  const slash = repoDir.lastIndexOf("/");
  const node: MutableNode = {
    id,
    label: slash === -1 ? repoDir : repoDir.slice(slash + 1),
    sourcePath: repoDir,
    children: [],
    blockId: null,
    folder: true,
    parentId: null,
  };
  nodes.set(id, node);
  return node;
}

function link(nodes: Map<string, MutableNode>, parentId: string, childId: string, child: MutableNode): void {
  const parent = nodes.get(parentId);
  if (parent === undefined || parentId === childId) return;
  const current = nodes.get(childId);
  if (current === undefined) {
    child.parentId = parentId;
    nodes.set(childId, child);
  } else if (current.parentId === null) {
    current.parentId = parentId;
  }
  if (!parent.children.includes(childId)) parent.children.push(childId);
}

function folderForBlock(
  nodes: Map<string, MutableNode>,
  block: FileTreeSource,
  blockById: ReadonlyMap<string, FileTreeSource>,
  scopeId: string,
  scopeDir: string,
): string {
  let parentId = block.parentId;
  const seen = new Set<string>();
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    if (parentId === scopeId) return scopeId;
    const parent = blockById.get(parentId);
    if (parent === undefined) return scopeId;
    const path = normalizeRepoPath(parent.sourcePath);
    if (path !== null) {
      const relative = relativeTo(path, scopeDir);
      const dir = relative === null || relative === "" ? scopeDir : parentDirectory(path);
      if (dir === "" || dir === scopeDir) return scopeId;
      const folder = ensureFolder(nodes, dir);
      const scope = nodes.get(scopeId);
      if (scope !== undefined && !connected(nodes, scopeId, folder.id)) {
        attachFolderChain(nodes, scopeId, scopeDir, dir);
      }
      return folder.id;
    }
    parentId = parent.parentId;
  }
  return scopeId;
}

function attachFolderChain(nodes: Map<string, MutableNode>, scopeId: string, scopeDir: string, repoDir: string): void {
  const relative = relativeTo(repoDir, scopeDir);
  if (relative === null || relative === "") return;
  let parentId = scopeId;
  let dir = scopeDir;
  for (const part of relative.split("/")) {
    dir = dir === "" ? part : `${dir}/${part}`;
    const folder = ensureFolder(nodes, dir);
    link(nodes, parentId, folder.id, folder);
    parentId = folder.id;
  }
}

function connected(nodes: Map<string, MutableNode>, origin: string, target: string): boolean {
  const pending = [origin];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    const node = nodes.get(current);
    if (node !== undefined) pending.push(...node.children);
  }
  return false;
}

function descendants(scope: FileTreeSource, blockById: ReadonlyMap<string, FileTreeSource>): FileTreeSource[] {
  const entries: FileTreeSource[] = [];
  const seen = new Set<string>();
  const pending = [scope];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || seen.has(current.id)) continue;
    seen.add(current.id);
    entries.push(current);
    for (const childId of current.children) {
      const child = blockById.get(childId);
      if (child !== undefined && !seen.has(child.id)) pending.push(child);
    }
  }
  return entries;
}

function compareChild(left: MutableNode | undefined, right: MutableNode | undefined, leftId: string, rightId: string): number {
  const leftFolder = left?.folder === true;
  const rightFolder = right?.folder === true;
  if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
  const leftLabel = left?.label ?? leftId;
  const rightLabel = right?.label ?? rightId;
  if (leftLabel < rightLabel) return -1;
  if (leftLabel > rightLabel) return 1;
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function folderDisplay(node: FileTreeNode): DisplayBlock {
  return {
    id: node.id,
    label: node.label,
    type: "workspace",
    parentId: node.parentId,
    children: node.children,
    sourcePath: node.sourcePath,
    fingerprint: "",
    memberCount: node.children.length,
    description: node.sourcePath ?? node.label,
    annotationKind: "APP",
    status: "ready",
    annotationState: "missing",
    virtual: false,
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function relativeTo(path: string, dir: string): string | null {
  if (dir === "") return path;
  if (path === dir) return "";
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length);
}

/** Repo-relative path, or null when the path could leave the repository. */
function normalizeRepoPath(sourcePath: string | null): string | null {
  if (sourcePath === null) return null;
  const cleaned = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (cleaned === "" || cleaned === ".") return "";
  if (cleaned.startsWith("/") || cleaned.split("/").includes("..")) return null;
  return cleaned;
}

/** True when the rule ignores the path, false when it un-ignores it, null when it does not match. */
function ruleEffect(rule: string, repoPath: string): boolean | null {
  let body = rule;
  let negate = false;
  if (body.startsWith("!")) {
    negate = true;
    body = body.slice(1);
  }
  if (body.endsWith("/")) body = body.slice(0, -1);
  if (body === "") return null;
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);
  if (body === "") return null;
  const regex = gitignoreRegex(body, anchored || body.includes("/"));
  if (regex.test(repoPath)) return !negate;
  const parts = repoPath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    if (regex.test(parts.slice(0, index).join("/"))) return !negate;
  }
  return null;
}

function gitignoreRegex(pattern: string, anchored: boolean): RegExp {
  const converted = convertGlob(pattern);
  const source = anchored ? `^${converted}$` : `(^|/)${converted}$`;
  return new RegExp(source);
}

function convertGlob(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        out += "(?:.*/)?";
        index += 2;
        continue;
      }
      out += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$+.()|[]{}".includes(char)) {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return out;
}
