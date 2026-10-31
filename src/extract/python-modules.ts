import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isIgnoredDirectory } from "../workspace-ignore.js";
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

const skippedDirectories = ["__pycache__", "venv", ".venv"];

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
  const baseTarget = longestKnownModule(candidate, knownModules);
  const fromImport =
    item.relativeLevel > 0 ||
    item.names.length !== 1 ||
    item.names[0]?.name !== item.module;
  if (fromImport) {
    for (const name of item.names) {
      if (name.name === "*") continue;
      const child = candidate.length === 0 ? name.name : `${candidate}.${name.name}`;
      const target = longestKnownModule(child, knownModules);
      if (target !== null && target !== baseTarget) return target;
    }
  }
  return baseTarget;
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
      const appId = [
        "app:python",
        pythonIdEncode(project.name),
        pythonIdEncode(entry.group),
        pythonIdEncode(entry.name),
        pythonIdEncode(entry.objectRef),
      ].join(":");
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
    const id = moduleIds.get(module.name);
    if (id === undefined) continue;
    const relative = toSlash(path.relative(args.rootPath, module.path));
    const fingerprint = hashFile(module.path);
    const packageName = module.packageName ?? module.name;
    const packageParent =
      module.packageName !== null && module.packageName !== module.name
        ? moduleIds.get(module.packageName)
        : undefined;
    const parentId = packageParent ?? projectParent;
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
    const sourceId = moduleIds.get(module.name);
    if (sourceId === undefined) continue;
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
    if (entry.name.startsWith(".") || isIgnoredDirectory(entry.name, skippedDirectories)) continue;
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
  const importRoot = pythonImportRoot(root, filePath);
  let directory = path.dirname(filePath);
  while (true) {
    if (packages.has(directory)) return dottedDirectory(importRoot, directory);
    if (directory === root) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function moduleName(root: string, filePath: string): string {
  const parts = path.relative(pythonImportRoot(root, filePath), filePath).split(path.sep).filter((part) => part.length > 0);
  const fileName = parts.pop() ?? "";
  const extension = path.extname(fileName);
  const stem = extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
  if (stem !== "__init__") parts.push(stem);
  return parts.join(".");
}

function pythonImportRoot(root: string, filePath: string): string {
  const src = path.join(root, "src");
  const relative = path.relative(src, filePath);
  const underSrc = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  const srcIsNotPackage = !existsSync(path.join(src, "__init__.py")) && !existsSync(path.join(src, "__init__.pyi"));
  return underSrc && srcIsNotPackage ? src : root;
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

function pythonIdEncode(value: string): string {
  let encoded = "";
  for (const character of value) {
    encoded += /^[A-Za-z0-9]$/u.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16) ?? ""}_`;
  }
  return encoded;
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

function readPyproject(manifestPath: string): PythonProject | null {
  const source = readFileSync(manifestPath, "utf8");
  const values = parseTomlStrings(source);
  if (values === null) return null;
  const name =
    tomlString(values, ["project", "name"]) ??
    tomlString(values, ["tool", "poetry", "name"]) ??
    "python-project";
  const entryPoints: PythonEntryPoint[] = [
    ...tomlTableEntries(values, ["project", "scripts"]).map(([script, objectRef]) => ({
      name: script,
      objectRef,
      group: "console_scripts",
    })),
    ...tomlTableEntries(values, ["project", "gui-scripts"]).map(([script, objectRef]) => ({
      name: script,
      objectRef,
      group: "gui_scripts",
    })),
    ...tomlEntryPointGroups(values),
    ...tomlTableEntries(values, ["tool", "poetry", "scripts"]).map(([script, objectRef]) => ({
      name: script,
      objectRef,
      group: "console_scripts",
    })),
  ];
  return { name, manifestPath, kind: "pyproject.toml", entryPoints: sortedUniqueEntryPoints(entryPoints) };
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
    if (section === "metadata") {
      const property = cfgProperty(line);
      if (property?.[0] === "name" && property[1].length > 0) name = property[1];
      continue;
    }
    if (section !== "options.entry_points") continue;
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!indented) {
      const property = cfgProperty(line);
      const group = property?.[0] ?? line;
      const rest = property?.[1] ?? "";
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
  return { name, manifestPath, kind: "setup.cfg", entryPoints: sortedUniqueEntryPoints(entryPoints) };
}

function readSetupPy(manifestPath: string): PythonProject {
  const source = readFileSync(manifestPath, "utf8");
  const call = setupCallBody(source) ?? "";
  const nameValue = pythonKeywordAssignment(call, "name")?.trimStart() ?? "";
  const name = quotedString(nameValue, 0)?.value;
  return {
    name: name && name.length > 0 ? name : "python-project",
    manifestPath,
    kind: "setup.py",
    entryPoints: setupPyEntryPoints(call),
  };
}

function setupPyEntryPoints(source: string): PythonEntryPoint[] {
  const value = pythonKeywordAssignment(source, "entry_points")?.trimStart();
  if (value?.[0] !== "{") return [];
  const dictionary = balancedBody(value, 0, "{", "}");
  if (dictionary === null) return [];

  const entryPoints: PythonEntryPoint[] = [];
  let cursor = 0;
  while (cursor < dictionary.body.length) {
    const quoteStart = findQuote(dictionary.body, cursor);
    if (quoteStart < 0) break;
    const group = quotedString(dictionary.body, quoteStart);
    if (group === null) break;
    const afterGroup: string = dictionary.body.slice(group.after);
    const leadingWhitespace: number = afterGroup.length - afterGroup.trimStart().length;
    const colon = group.after + leadingWhitespace;
    if (dictionary.body[colon] !== ":") {
      cursor = group.after;
      continue;
    }
    const afterColon: string = dictionary.body.slice(colon + 1);
    const valueWhitespace: number = afterColon.length - afterColon.trimStart().length;
    const listStart = colon + 1 + valueWhitespace;
    if (dictionary.body[listStart] !== "[") {
      cursor = group.after;
      continue;
    }
    const list = balancedBody(dictionary.body, listStart, "[", "]");
    if (list === null) {
      cursor = group.after;
      continue;
    }
    let listCursor = 0;
    while (listCursor < list.body.length) {
      const entryStart = findQuote(list.body, listCursor);
      if (entryStart < 0) break;
      const entry = quotedString(list.body, entryStart);
      if (entry === null) break;
      const splitAt = entry.value.indexOf("=");
      if (splitAt >= 0) {
        const name = entry.value.slice(0, splitAt).trim();
        const objectRef = entry.value.slice(splitAt + 1).trim();
        if (name.length > 0 && objectRef.length > 0) {
          entryPoints.push({ name, objectRef, group: group.value });
        }
      }
      listCursor = entry.after;
    }
    cursor = list.after;
  }
  return sortedUniqueEntryPoints(entryPoints);
}

function cfgProperty(line: string): readonly [string, string] | null {
  const equals = line.indexOf("=");
  const colon = line.indexOf(":");
  const indexes = [equals, colon].filter((index) => index >= 0);
  if (indexes.length === 0) return null;
  const separator = Math.min(...indexes);
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
}

function sortedUniqueEntryPoints(entryPoints: readonly PythonEntryPoint[]): PythonEntryPoint[] {
  const sorted = [...entryPoints].sort((left, right) =>
    byteCompare(left.group, right.group) ||
    byteCompare(left.name, right.name) ||
    byteCompare(left.objectRef, right.objectRef),
  );
  return sorted.filter((entry, index) => {
    const previous = sorted[index - 1];
    return previous === undefined ||
      entry.group !== previous.group ||
      entry.name !== previous.name ||
      entry.objectRef !== previous.objectRef;
  });
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function setupCallBody(source: string): string | null {
  const mask = pythonCodeMask(source);
  const pattern = /\bsetup\b/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(mask)) !== null) {
    const rest = mask.slice(match.index + match[0].length);
    const whitespace = rest.length - rest.trimStart().length;
    const open = match.index + match[0].length + whitespace;
    if (mask[open] !== "(") continue;
    const call = balancedBody(mask, open, "(", ")");
    if (call === null) return null;
    return source.slice(open + 1, call.after - 1);
  }
  return null;
}

function pythonKeywordAssignment(source: string, keyword: string): string | null {
  const mask = pythonCodeMask(source);
  let cursor = 0;
  while (cursor < mask.length) {
    const index = mask.indexOf(keyword, cursor);
    if (index < 0) return null;
    cursor = index + keyword.length;
    const before = mask[index - 1];
    const after = mask[index + keyword.length];
    if ((before !== undefined && /[A-Za-z0-9_]/u.test(before)) ||
        (after !== undefined && /[A-Za-z0-9_]/u.test(after))) continue;
    const rest = mask.slice(index + keyword.length);
    const whitespace = rest.length - rest.trimStart().length;
    const equals = index + keyword.length + whitespace;
    if (mask[equals] !== "=") continue;
    return source.slice(equals + 1);
  }
  return null;
}

function pythonCodeMask(source: string): string {
  const masked = source.split("");
  let quote: "'" | '"' | null = null;
  let triple = false;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (comment) {
      if (character === "\n") comment = false;
      else masked[index] = " ";
      continue;
    }
    if (quote !== null) {
      masked[index] = character === "\n" ? "\n" : " ";
      if (!triple && character === "\\") {
        if (index + 1 < source.length) masked[index + 1] = " ";
        index += 1;
      } else if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        masked[index + 1] = " ";
        masked[index + 2] = " ";
        index += 2;
        quote = null;
        triple = false;
      } else if (!triple && character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "#") {
      masked[index] = " ";
      comment = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      triple = source.slice(index, index + 3) === character.repeat(3);
      masked[index] = " ";
      if (triple) {
        masked[index + 1] = " ";
        masked[index + 2] = " ";
        index += 2;
      }
    }
  }
  return masked.join("");
}

function balancedBody(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): { readonly body: string; readonly after: number } | null {
  if (source[openIndex] !== open) return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return { body: source.slice(openIndex + 1, index), after: index + 1 };
    }
  }
  return null;
}

function findQuote(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "'" || source[index] === '"') return index;
  }
  return -1;
}

function quotedString(
  source: string,
  start: number,
): { readonly value: string; readonly after: number } | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let value = "";
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return { value, after: index + 1 };
    } else {
      value += character;
    }
  }
  return null;
}

interface TomlStringValue {
  readonly path: readonly string[];
  readonly value: string;
}

function parseTomlStrings(source: string): TomlStringValue[] | null {
  const values: TomlStringValue[] = [];
  let table: readonly string[] = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    if (line.startsWith("[")) {
      const arrayTable = line.startsWith("[[");
      const expectedEnd = arrayTable ? "]]" : "]";
      if (!line.endsWith(expectedEnd)) return null;
      const parsed = parseTomlKey(line.slice(arrayTable ? 2 : 1, arrayTable ? -2 : -1));
      if (parsed === null || parsed.length === 0) return null;
      table = parsed;
      continue;
    }
    const equals = findTomlTopLevel(line, "=");
    if (equals < 0) continue;
    const key = parseTomlKey(line.slice(0, equals));
    if (key === null || key.length === 0) return null;
    parseTomlValue(line.slice(equals + 1).trim(), [...table, ...key], values);
  }
  return values;
}

function parseTomlValue(value: string, keyPath: readonly string[], values: TomlStringValue[]): void {
  const quoted = parseTomlQuoted(value, 0);
  if (quoted !== null && value.slice(quoted.after).trim().length === 0) {
    values.push({ path: keyPath, value: quoted.value });
    return;
  }
  if (!value.startsWith("{") || !value.endsWith("}")) return;
  for (const item of splitTomlTopLevel(value.slice(1, -1), ",")) {
    if (item.trim().length === 0) continue;
    const equals = findTomlTopLevel(item, "=");
    if (equals < 0) continue;
    const child = parseTomlKey(item.slice(0, equals));
    if (child === null || child.length === 0) continue;
    parseTomlValue(item.slice(equals + 1).trim(), [...keyPath, ...child], values);
  }
}

function tomlString(values: readonly TomlStringValue[], keys: readonly string[]): string | null {
  return values.find((entry) => sameTomlPath(entry.path, keys))?.value ?? null;
}

function tomlTableEntries(values: readonly TomlStringValue[], keys: readonly string[]): Array<[string, string]> {
  return values.flatMap((entry) =>
    entry.path.length === keys.length + 1 && sameTomlPath(entry.path.slice(0, -1), keys)
      ? [[entry.path[entry.path.length - 1] ?? "", entry.value] as [string, string]]
      : []
  );
}

function tomlEntryPointGroups(values: readonly TomlStringValue[]): PythonEntryPoint[] {
  return values.flatMap((entry) =>
    entry.path.length === 4 && sameTomlPath(entry.path.slice(0, 2), ["project", "entry-points"])
      ? [{ group: entry.path[2] ?? "", name: entry.path[3] ?? "", objectRef: entry.value }]
      : []
  );
}

function sameTomlPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function parseTomlKey(source: string): string[] | null {
  const parts = splitTomlTopLevel(source, ".");
  const keys: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part.length === 0) return null;
    const quoted = parseTomlQuoted(part, 0);
    if (quoted !== null && quoted.after === part.length) keys.push(quoted.value);
    else if (/^[A-Za-z0-9_-]+$/u.test(part)) keys.push(part);
    else return null;
  }
  return keys;
}

function parseTomlQuoted(source: string, start: number): { readonly value: string; readonly after: number } | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (quote === '"' && !escaped && character === "\\") {
      escaped = true;
      continue;
    }
    if (!escaped && character === quote) {
      const raw = source.slice(start, index + 1);
      if (quote === "'") return { value: raw.slice(1, -1), after: index + 1 };
      try {
        return { value: JSON.parse(raw) as string, after: index + 1 };
      } catch {
        return null;
      }
    }
    escaped = false;
  }
  return null;
}

function stripTomlComment(source: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "#") return source.slice(0, index);
  }
  return source;
}

function findTomlTopLevel(source: string, needle: string): number {
  let quote: string | null = null;
  let escaped = false;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === needle && braces === 0) return index;
  }
  return -1;
}

function splitTomlTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === separator && braces === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}
