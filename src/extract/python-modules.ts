import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AppBlock, FactBlock, FactConnection, ModuleBlock } from "../model.js";

export type PythonSymbolKind = "def" | "async def" | "class";
export type PythonManifestKind = "pyproject.toml" | "setup.cfg" | "setup.py";

export interface PythonImportedName {
  readonly name: string;
  readonly alias: string | null;
}

export interface PythonImport {
  readonly line: number;
  readonly module: string;
  readonly relativeLevel: number;
  readonly names: readonly PythonImportedName[];
}

export interface PythonSymbol {
  readonly name: string;
  readonly kind: PythonSymbolKind;
  readonly line: number;
}

export interface PythonModule {
  readonly name: string;
  readonly path: string;
  readonly packageName: string | null;
  readonly stub: boolean;
  readonly unreadable: boolean;
  readonly imports: readonly PythonImport[];
  readonly symbols: readonly PythonSymbol[];
}

export interface PythonEntryPoint {
  readonly name: string;
  readonly objectRef: string;
  readonly group: string;
}

export interface PythonProject {
  readonly name: string;
  readonly manifestPath: string;
  readonly kind: PythonManifestKind;
  readonly entryPoints: readonly PythonEntryPoint[];
}

const skippedDirectories = new Set(["__pycache__", "node_modules", "target", "dist", "venv", ".venv"]);

type Quote = "single" | "double" | "tripleSingle" | "tripleDouble";

interface ScanState {
  quote: Quote | null;
  paren: number;
}

export function discoverPythonModules(repositoryPath: string): PythonModule[] {
  const root = path.resolve(repositoryPath);
  const canonicalRoot = realpathSync(root);
  const files: string[] = [];
  walkPythonFiles(root, canonicalRoot, new Set(), files);
  const packages = packageDirectories(files);
  const modules = files.map((filePath) => moduleFromFile(root, filePath, packages));
  modules.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    if (left.stub !== right.stub) return left.stub ? 1 : -1;
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  return modules;
}

export function discoverPythonProject(repositoryPath: string): PythonProject | null {
  const root = path.resolve(repositoryPath);
  const pyproject = path.join(root, "pyproject.toml");
  if (existsSync(pyproject)) return readPyproject(pyproject);
  const setupCfg = path.join(root, "setup.cfg");
  if (existsSync(setupCfg)) return readSetupCfg(setupCfg);
  const setupPy = path.join(root, "setup.py");
  if (existsSync(setupPy)) return readSetupPy(setupPy);
  return null;
}

export function resolvePythonImport(
  from: PythonModule,
  item: PythonImport,
  knownModules: ReadonlySet<string>,
): string | null {
  let candidate: string;
  if (item.relativeLevel > 0) {
    const packageName = containingPackage(from);
    if (packageName === null) return null;
    const resolved = resolveRelativeImport(packageName, item.relativeLevel, item.module);
    if (resolved === null) return null;
    candidate = resolved;
  } else if (item.module.length === 0) {
    return null;
  } else {
    candidate = item.module;
  }
  return longestKnownModule(candidate, knownModules);
}

export function parsePythonSource(source: string): { readonly imports: PythonImport[]; readonly symbols: PythonSymbol[] } {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const imports: PythonImport[] = [];
  const symbols: PythonSymbol[] = [];
  const state: ScanState = { quote: null, paren: 0 };
  let logical = "";
  let logicalLine = 1;
  let continued = false;
  for (const [index, rawLine] of splitInclusive(text).entries()) {
    const lineNo = index + 1;
    const line = rawLine.replace(/[\n\r]+$/, "");
    if (state.quote !== null) {
      scanLine(line, state);
      continue;
    }
    if (state.paren > 0 || continued) {
      logical += `\n${line}`;
      continued = scanLine(line, state);
      if (state.paren === 0 && state.quote === null && !continued) {
        classify(logical, logicalLine, imports, symbols);
        logical = "";
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (line.length !== trimmed.length) continue;
    logical = line;
    logicalLine = lineNo;
    continued = scanLine(line, state);
    if (state.paren === 0 && state.quote === null && !continued) {
      classify(logical, logicalLine, imports, symbols);
      logical = "";
    }
  }
  return { imports, symbols };
}

export function pythonImportStatement(item: PythonImport): string {
  if (item.names.length === 1 && item.names[0]?.name === item.module && item.relativeLevel === 0) {
    const alias = item.names[0].alias;
    return alias === null ? `import ${item.module}` : `import ${item.module} as ${alias}`;
  }
  const dots = ".".repeat(item.relativeLevel);
  const names = item.names
    .map((name) => (name.alias === null ? name.name : `${name.name} as ${name.alias}`))
    .join(", ");
  if (item.module.length === 0) return `from ${dots} import ${names}`;
  if (item.relativeLevel === 0) return `from ${item.module} import ${names}`;
  return `from ${dots}${item.module} import ${names}`;
}

export function pythonFactBlocks(args: {
  readonly modules: readonly PythonModule[];
  readonly project?: PythonProject | null;
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: FactBlock[]; readonly connections: FactConnection[] } {
  const blocks: FactBlock[] = [];
  const connections: FactConnection[] = [];
  let projectParent = args.workspaceId;
  if (args.project) {
    const project = args.project;
    const projectId = `module:python:project:${slug(project.name)}`;
    const relative = toSlash(path.relative(args.rootPath, project.manifestPath));
    const fingerprint = hashFile(project.manifestPath);
    blocks.push({
      id: projectId,
      label: project.name,
      type: "module",
      packageName: project.name,
      modulePath: project.name,
      declaredByPath: relative,
      cfgAttributes: ["project", project.kind],
      unresolved: false,
      language: "python",
      parentId: args.workspaceId,
      children: [],
      sourcePath: relative,
      fingerprint,
    } satisfies ModuleBlock);
    connections.push(containsConnection(args.workspaceId, projectId));
    for (const entry of project.entryPoints) {
      const appId = `app:python:${slug(project.name)}:${slug(entry.name)}`;
      const entryModule = entry.objectRef.split(":")[0] ?? entry.objectRef;
      const modulePath = args.modules.find((module) => module.name === entryModule)?.path ?? project.manifestPath;
      const sourcePath = toSlash(path.relative(args.rootPath, modulePath));
      blocks.push({
        id: appId,
        label: entry.name,
        type: "app",
        packageName: project.name,
        targetName: entry.name,
        entryPath: sourcePath,
        targetKind: entry.group,
        parentId: projectId,
        children: [],
        sourcePath,
        fingerprint: hashFile(modulePath),
      } satisfies AppBlock);
      connections.push(containsConnection(projectId, appId));
    }
    projectParent = projectId;
  }

  const moduleIds = new Map(args.modules.map((module) => [module.name, pythonBlockId(module.name, module.stub, null)]));
  const knownModules = new Set(moduleIds.keys());
  for (const module of args.modules) {
    const id = moduleIds.get(module.name)!;
    const relative = toSlash(path.relative(args.rootPath, module.path));
    const fingerprint = hashFile(module.path);
    const packageName = module.packageName ?? module.name;
    const parentId =
      module.packageName !== null && module.packageName !== module.name && moduleIds.has(module.packageName)
        ? moduleIds.get(module.packageName)!
        : projectParent;
    blocks.push({
      id,
      label: moduleLabel(module.name),
      type: "module",
      packageName,
      modulePath: module.name,
      declaredByPath: relative,
      cfgAttributes: module.imports.map(pythonImportStatement),
      unresolved: module.unreadable,
      language: "python",
      parentId,
      children: [],
      sourcePath: relative,
      fingerprint,
    });
    connections.push(containsConnection(parentId, id));
    for (const symbol of module.symbols) {
      const modulePath = `${module.name}.${symbol.name}`;
      const symbolId = pythonBlockId(modulePath, module.stub, symbol.kind);
      blocks.push({
        id: symbolId,
        label: symbol.name,
        type: "module",
        packageName,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: [symbol.kind],
        unresolved: false,
        language: "python",
        parentId: id,
        children: [],
        sourcePath: relative,
        fingerprint,
      });
      connections.push(containsConnection(id, symbolId));
    }
  }

  const importEdges = new Set<string>();
  for (const module of args.modules) {
    const sourceId = moduleIds.get(module.name)!;
    for (const item of module.imports) {
      const targetName = resolvePythonImport(module, item, knownModules);
      if (targetName === null) continue;
      const targetId = moduleIds.get(targetName);
      if (targetId === undefined || targetId === sourceId) continue;
      const edgeId = `depends_on:${sourceId}->${targetId}`;
      if (importEdges.has(edgeId)) continue;
      importEdges.add(edgeId);
      connections.push({
        id: edgeId,
        source: sourceId,
        target: targetId,
        kind: "depends_on",
        dependencyScope: "normal",
      });
    }
  }
  return { blocks, connections };
}

function moduleFromFile(root: string, filePath: string, packages: ReadonlySet<string>): PythonModule {
  const source = readPythonSource(filePath);
  const parsed = source === null ? { imports: [], symbols: [] } : parsePythonSource(source);
  return {
    name: moduleName(root, filePath),
    path: filePath,
    packageName: nearestPackage(root, filePath, packages),
    stub: filePath.endsWith(".pyi"),
    unreadable: source === null,
    imports: parsed.imports,
    symbols: parsed.symbols,
  };
}

function walkPythonFiles(directory: string, canonicalRoot: string, seen: Set<string>, files: string[]): void {
  let canonical: string;
  try {
    canonical = realpathSync(directory);
  } catch {
    return;
  }
  if (!isConfined(canonicalRoot, canonical) || seen.has(canonical)) return;
  seen.add(canonical);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkPythonFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!isPythonFile(child) || !isConfinedFile(child, canonicalRoot)) continue;
    files.push(child);
  }
}

function isConfinedFile(filePath: string, canonicalRoot: string): boolean {
  try {
    return isConfined(canonicalRoot, realpathSync(filePath));
  } catch {
    return false;
  }
}

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPythonFile(filePath: string): boolean {
  return filePath.endsWith(".py") || filePath.endsWith(".pyi");
}

function packageDirectories(files: readonly string[]): Set<string> {
  const packages = new Set<string>();
  for (const filePath of files) {
    const base = path.basename(filePath);
    if (base === "__init__.py" || base === "__init__.pyi") {
      const parent = path.dirname(filePath);
      packages.add(parent);
    }
  }
  return packages;
}

function nearestPackage(root: string, filePath: string, packages: ReadonlySet<string>): string | null {
  let directory = path.dirname(filePath);
  while (true) {
    if (packages.has(directory)) return dottedDirectory(root, directory);
    if (directory === root) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function moduleName(root: string, filePath: string): string {
  const parts = path.relative(root, filePath).split(path.sep).filter((part) => part.length > 0);
  const fileName = parts.pop() ?? "";
  const extension = path.extname(fileName);
  const stem = extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
  if (stem !== "__init__") parts.push(stem);
  return parts.join(".");
}

function dottedDirectory(root: string, directory: string): string {
  return path.relative(root, directory).split(path.sep).filter((part) => part.length > 0).join(".");
}

function splitInclusive(source: string): string[] {
  if (source.length === 0) return [];
  const parts = source.split(/(\n)/);
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? "";
    const newline = parts[index + 1] ?? "";
    if (text.length === 0 && newline.length === 0) continue;
    lines.push(`${text}${newline}`);
  }
  return lines;
}

function scanLine(line: string, state: ScanState): boolean {
  const chars = Array.from(line);
  let index = 0;
  while (index < chars.length) {
    if (state.quote !== null) {
      const quote = state.quote;
      if (closesQuote(chars, index, quote)) {
        index += quoteLen(quote);
        state.quote = null;
        continue;
      }
      if (chars[index] === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (chars[index] === "#") break;
    if (chars[index] === "\\" && index + 1 === chars.length) return true;
    const opened = opensQuote(chars, index);
    if (opened !== null) {
      index += quoteLen(opened);
      state.quote = opened;
      continue;
    }
    const character = chars[index];
    if (character === "(" || character === "[" || character === "{") state.paren += 1;
    else if (character === ")" || character === "]" || character === "}") state.paren -= 1;
    index += 1;
  }
  return false;
}

function opensQuote(chars: readonly string[], index: number): Quote | null {
  if (startsWithAt(chars, index, ["'", "'", "'"])) return "tripleSingle";
  if (startsWithAt(chars, index, ['"', '"', '"'])) return "tripleDouble";
  if (chars[index] === "'") return "single";
  if (chars[index] === '"') return "double";
  return null;
}

function closesQuote(chars: readonly string[], index: number, quote: Quote): boolean {
  if (quote === "single") return chars[index] === "'" && !escaped(chars, index);
  if (quote === "double") return chars[index] === '"' && !escaped(chars, index);
  if (quote === "tripleSingle") return startsWithAt(chars, index, ["'", "'", "'"]);
  return startsWithAt(chars, index, ['"', '"', '"']);
}

function quoteLen(quote: Quote): number {
  return quote === "single" || quote === "double" ? 1 : 3;
}

function escaped(chars: readonly string[], index: number): boolean {
  let slashes = 0;
  let cursor = index;
  while (cursor > 0 && chars[cursor - 1] === "\\") {
    slashes += 1;
    cursor -= 1;
  }
  return slashes % 2 === 1;
}

function startsWithAt(chars: readonly string[], index: number, needle: readonly string[]): boolean {
  if (index + needle.length > chars.length) return false;
  return needle.every((character, offset) => chars[index + offset] === character);
}

function classify(statement: string, line: number, imports: PythonImport[], symbols: PythonSymbol[]): void {
  const trimmed = blankStrings(statement).trim();
  if (trimmed.startsWith("@")) return;
  const asyncName = keywordName(trimmed, "async def");
  if (asyncName !== null) {
    symbols.push({ name: asyncName, kind: "async def", line });
    return;
  }
  const functionName = keywordName(trimmed, "def");
  if (functionName !== null) {
    symbols.push({ name: functionName, kind: "def", line });
    return;
  }
  const className = keywordName(trimmed, "class");
  if (className !== null) {
    symbols.push({ name: className, kind: "class", line });
    return;
  }
  if (trimmed.startsWith("import ")) {
    imports.push(...parseImport(trimmed.slice("import ".length), line));
    return;
  }
  if (trimmed.startsWith("from ")) {
    const imported = parseFrom(trimmed.slice("from ".length), line);
    if (imported !== null) imports.push(imported);
  }
}

function blankStrings(statement: string): string {
  const chars = Array.from(statement);
  let index = 0;
  let quote: Quote | null = null;
  let blanked = "";
  while (index < chars.length) {
    if (quote !== null) {
      if (closesQuote(chars, index, quote)) {
        index += quoteLen(quote);
        quote = null;
        continue;
      }
      if (chars[index] === "\\") index += 1;
      if (index < chars.length) {
        blanked += chars[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    const opened = opensQuote(chars, index);
    if (opened !== null) {
      quote = opened;
      index += quoteLen(opened);
      continue;
    }
    blanked += chars[index];
    index += 1;
  }
  return blanked;
}

function keywordName(statement: string, keyword: string): string | null {
  if (!statement.startsWith(keyword)) return null;
  const rest = statement.slice(keyword.length);
  const first = Array.from(rest)[0];
  if (first !== undefined && !/\s/u.test(first)) return null;
  let name = "";
  for (const character of rest.trimStart()) {
    if (/[A-Za-z0-9_]/u.test(character)) name += character;
    else break;
  }
  if (name.length === 0 || /[0-9]/u.test(name[0] ?? "")) return null;
  return name;
}

function parseImport(rest: string, line: number): PythonImport[] {
  const imports: PythonImport[] = [];
  for (const part of splitTopLevel(rest, ",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [module, alias] = splitAlias(trimmed);
    imports.push({
      line,
      module,
      relativeLevel: 0,
      names: [{ name: module, alias }],
    });
  }
  return imports;
}

function parseFrom(rest: string, line: number): PythonImport | null {
  const splitAt = rest.indexOf(" import ");
  if (splitAt < 0) return null;
  const moduleToken = rest.slice(0, splitAt).trim();
  const namesToken = rest.slice(splitAt + " import ".length).replaceAll("(", " ").replaceAll(")", " ");
  const [relativeLevel, module] = splitRelative(moduleToken);
  const names: PythonImportedName[] = [];
  for (const part of splitTopLevel(namesToken, ",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [name, alias] = splitAlias(trimmed);
    names.push({ name, alias });
  }
  if (names.length === 0) return null;
  return { line, module, relativeLevel, names };
}

function splitAlias(part: string): [string, string | null] {
  const splitAt = part.indexOf(" as ");
  if (splitAt < 0) return [part.trim(), null];
  return [part.slice(0, splitAt).trim(), part.slice(splitAt + " as ".length).trim()];
}

function splitRelative(token: string): [number, string] {
  let level = 0;
  while (token[level] === ".") level += 1;
  return [level, token.slice(level).trim()];
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      current += character;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      current += character;
    } else if (character === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function pythonBlockId(modulePath: string, stub: boolean, kind: string | null): string {
  let id = `module:python:${slug(modulePath)}`;
  if (stub) id += ":stub";
  if (kind !== null) id += `:${slug(kind)}`;
  return id;
}

function moduleLabel(moduleName: string): string {
  const parts = moduleName.split(".");
  return parts[parts.length - 1] ?? moduleName;
}

function containsConnection(source: string, target: string): FactConnection {
  return { id: `contains:${source}->${target}`, source, target, kind: "contains" };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toSlash(value: string): string {
  return value.split(path.sep).join("/");
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readPythonSource(filePath: string): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    throw new Error(`Could not read Python source ${filePath}: ${message}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function containingPackage(module: PythonModule): string | null {
  if (path.parse(module.path).name === "__init__") return module.name;
  const index = module.name.lastIndexOf(".");
  return index < 0 ? null : module.name.slice(0, index);
}

function resolveRelativeImport(packageName: string, level: number, module: string): string | null {
  if (level <= 0) return null;
  const parts = packageName.split(".").filter((part) => part.length > 0);
  const up = level - 1;
  if (up > parts.length) return null;
  parts.length -= up;
  if (module.length > 0) parts.push(...module.split(".").filter((part) => part.length > 0));
  return parts.length === 0 ? null : parts.join(".");
}

function longestKnownModule(candidate: string, known: ReadonlySet<string>): string | null {
  const parts = candidate.split(".");
  while (parts.length > 0) {
    const joined = parts.join(".");
    if (known.has(joined)) return joined;
    parts.pop();
  }
  return null;
}

function readPyproject(manifestPath: string): PythonProject {
  const source = readFileSync(manifestPath, "utf8");
  const name =
    tomlString(source, ["project", "name"]) ??
    tomlString(source, ["tool", "poetry", "name"]) ??
    "python-project";
  const entryPoints: PythonEntryPoint[] = [
    ...tomlTableEntries(source, ["project", "scripts"]).map(([script, objectRef]) => ({
      name: script,
      objectRef,
      group: "console_scripts",
    })),
    ...tomlTableEntries(source, ["project", "gui-scripts"]).map(([script, objectRef]) => ({
      name: script,
      objectRef,
      group: "gui_scripts",
    })),
    ...tomlEntryPointGroups(source),
    ...tomlTableEntries(source, ["tool", "poetry", "scripts"]).map(([script, objectRef]) => ({
      name: script,
      objectRef,
      group: "console_scripts",
    })),
  ];
  entryPoints.sort((left, right) =>
    left.group.localeCompare(right.group) ||
    left.name.localeCompare(right.name) ||
    left.objectRef.localeCompare(right.objectRef),
  );
  return { name, manifestPath, kind: "pyproject.toml", entryPoints };
}

function readSetupCfg(manifestPath: string): PythonProject {
  const source = readFileSync(manifestPath, "utf8");
  let name = "python-project";
  const entryPoints: PythonEntryPoint[] = [];
  let section = "";
  let entryGroup: string | null = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      entryGroup = null;
      continue;
    }
    if (section === "metadata" && line.startsWith("name")) {
      const value = line.replace(/^name\s*=\s*/u, "").trim();
      if (value.length > 0) name = value;
      continue;
    }
    if (section !== "options.entry_points") continue;
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!indented) {
      const splitAt = line.indexOf("=");
      const group = (splitAt < 0 ? line : line.slice(0, splitAt)).trim();
      const rest = splitAt < 0 ? "" : line.slice(splitAt + 1).trim();
      entryGroup = group;
      if (rest.length > 0) {
        const entrySplit = rest.indexOf("=");
        if (entrySplit >= 0) {
          entryPoints.push({
            name: rest.slice(0, entrySplit).trim(),
            objectRef: rest.slice(entrySplit + 1).trim(),
            group,
          });
        }
      }
      continue;
    }
    if (entryGroup === null) continue;
    const entrySplit = line.indexOf("=");
    if (entrySplit < 0) continue;
    entryPoints.push({
      name: line.slice(0, entrySplit).trim(),
      objectRef: line.slice(entrySplit + 1).trim(),
      group: entryGroup,
    });
  }
  entryPoints.sort((left, right) => left.group.localeCompare(right.group) || left.name.localeCompare(right.name));
  return { name, manifestPath, kind: "setup.cfg", entryPoints };
}

function readSetupPy(manifestPath: string): PythonProject {
  const source = readFileSync(manifestPath, "utf8");
  const match = source.match(/\bname\s*=\s*["']([^"']+)["']/u);
  return {
    name: match?.[1] && match[1].length > 0 ? match[1] : "python-project",
    manifestPath,
    kind: "setup.py",
    entryPoints: [],
  };
}

function tomlString(source: string, keys: readonly string[]): string | null {
  const table = tomlTableBody(source, keys.slice(0, -1));
  if (table === null) return null;
  const key = keys[keys.length - 1];
  if (key === undefined) return null;
  const match = table.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, "mu"));
  return match?.[1] ?? null;
}

function tomlTableEntries(source: string, keys: readonly string[]): Array<[string, string]> {
  const body = tomlTableBody(source, keys);
  if (body === null) return [];
  const entries: Array<[string, string]> = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/u);
    if (match?.[1] && match[2] !== undefined) entries.push([match[1], match[2]]);
  }
  return entries;
}

function tomlEntryPointGroups(source: string): PythonEntryPoint[] {
  const entries: PythonEntryPoint[] = [];
  const pattern = /^\[project\.entry-points(?:\."([^"]+)"|\.([^\]]+))\]\s*$/gmu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const group = match[1] ?? match[2];
    if (group === undefined) continue;
    const start = match.index + match[0].length;
    const next = source.slice(start).search(/^\[/mu);
    const body = next < 0 ? source.slice(start) : source.slice(start, start + next);
    for (const line of body.split(/\r?\n/)) {
      const lineMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/u);
      if (lineMatch?.[1] && lineMatch[2] !== undefined) {
        entries.push({ name: lineMatch[1], objectRef: lineMatch[2], group });
      }
    }
  }
  return entries;
}

function tomlTableBody(source: string, keys: readonly string[]): string | null {
  if (keys.length === 0) return source;
  const header = `[${keys.join(".")}]`;
  const start = source.indexOf(header);
  if (start < 0) return null;
  const bodyStart = start + header.length;
  const rest = source.slice(bodyStart);
  const next = rest.search(/^\[/mu);
  return next < 0 ? rest : rest.slice(0, next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
