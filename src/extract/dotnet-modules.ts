import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { FactConnection, ModuleBlock } from "../model.js";

export type DotnetSymbolKind = "class" | "struct" | "record" | "interface" | "enum" | "module" | "method";

export interface DotnetImport {
  readonly line: number;
  readonly target: string;
  readonly alias: string | null;
  readonly global: boolean;
  readonly statement: string;
}

export interface DotnetSymbol {
  readonly name: string;
  readonly qualified: string;
  readonly kind: DotnetSymbolKind;
  readonly line: number;
  readonly namespace: string;
  readonly partial: boolean;
  readonly bases: string[];
  readonly memberTypes: string[];
}

export interface DotnetFile {
  readonly path: string;
  readonly language: "csharp" | "vb";
  readonly namespace: string;
  readonly projectPath: string | null;
  readonly unreadable: boolean;
  readonly imports: readonly DotnetImport[];
  readonly symbols: readonly DotnetSymbol[];
}

export interface DotnetProject {
  readonly name: string;
  readonly path: string;
  readonly language: "csharp" | "vb";
  readonly rootNamespace: string | null;
  readonly references: readonly string[];
}

export interface DotnetWorkspace {
  readonly projects: readonly DotnetProject[];
  readonly files: readonly DotnetFile[];
}

const skippedDirectories = new Set(["bin", "obj", "node_modules", "target", "dist"]);

type MaskMode =
  | { readonly kind: "code" }
  | { readonly kind: "line" }
  | { readonly kind: "block" }
  | { readonly kind: "char"; escape: boolean }
  | { readonly kind: "regular"; interpolated: boolean; braces: number; nested: boolean; escape: boolean }
  | { readonly kind: "verbatim"; interpolated: boolean; braces: number; nested: boolean }
  | { readonly kind: "raw"; quotes: number; interpolated: boolean; braces: number; nested: boolean };

interface TypeFrame {
  readonly qualified: string;
  readonly simple: string;
  readonly kind: DotnetSymbolKind;
  readonly endDepth: number;
  readonly bodyDepth: number;
}

interface NsFrame {
  readonly full: string;
  readonly endDepth: number;
}

export function discoverDotnet(repositoryPath: string): DotnetWorkspace {
  const root = path.resolve(repositoryPath);
  const canonicalRoot = realpathSync(root);
  const found: string[] = [];
  walkDotnetFiles(root, canonicalRoot, new Set(), found);
  found.sort((left, right) => compareText(left, right));
  const projects: DotnetProject[] = [];
  const sourcePaths: string[] = [];
  const solutions: string[] = [];
  for (const filePath of found) {
    const extension = extensionOf(filePath);
    if (extension === "csproj" || extension === "vbproj") projects.push(projectFromFile(filePath));
    else if (extension === "sln") solutions.push(filePath);
    else if (extension === "cs" || extension === "vb") sourcePaths.push(filePath);
  }
  for (const solution of solutions) {
    let text: string;
    try {
      text = readFileSync(solution, "utf8");
    } catch {
      continue;
    }
    const base = path.dirname(solution);
    for (const relative of solutionProjectPaths(text)) {
      const projectPath = portableJoin(base, relative);
      if (projects.some((project) => pathsMatch(project.path, projectPath))) continue;
      const extension = extensionOf(projectPath);
      if ((extension === "csproj" || extension === "vbproj") && confined(projectPath, canonicalRoot)) {
        projects.push(projectFromFile(projectPath));
      }
    }
  }
  projects.sort((left, right) => compareText(left.name, right.name) || compareText(left.path, right.path));
  const files = sourcePaths.map((filePath) => applyRootNamespace(fileFromPath(filePath, projects), projects));
  files.sort((left, right) => compareText(left.path, right.path));
  return { projects, files };
}

export function parseCsharpSource(source: string): { readonly imports: DotnetImport[]; readonly symbols: DotnetSymbol[] } {
  return parseCsharp(maskCsharp(stripBom(source)));
}

export function parseVbSource(source: string): { readonly imports: DotnetImport[]; readonly symbols: DotnetSymbol[] } {
  return parseVb(maskVb(stripBom(source)));
}

export function solutionProjectPaths(source: string): string[] {
  const paths: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Project(")) continue;
    const rest = trimmed.slice("Project(".length);
    const eq = rest.indexOf("=");
    if (eq < 0) continue;
    const quotes: string[] = [];
    let current = "";
    let inQuote = false;
    for (const character of rest.slice(eq + 1)) {
      if (character === '"') {
        if (inQuote) quotes.push(current);
        current = "";
        inQuote = !inQuote;
        continue;
      }
      if (inQuote) current += character;
    }
    if (quotes.length >= 2) paths.push(quotes[1] ?? "");
  }
  return paths;
}

export function dotnetFactBlocks(args: {
  readonly workspace: DotnetWorkspace;
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const seen = new Set<string>();
  const projectIds = new Map<string, string>();
  for (const project of args.workspace.projects) {
    const relative = slashRelative(args.rootPath, project.path);
    const id = dotnetBlockId("project", [relative]);
    pushModule(blocks, connections, {
      id,
      label: project.name,
      parent: args.workspaceId,
      packageName: project.name,
      modulePath: project.name,
      declaredBy: relative,
      cfgAttributes: ["project"],
      unresolved: false,
      language: project.language,
      source: relative,
      fingerprint: hashFile(project.path),
    });
    projectIds.set(normalizePath(project.path), id);
  }
  for (const project of args.workspace.projects) {
    const sourceId = projectIds.get(normalizePath(project.path));
    if (sourceId === undefined) continue;
    for (const reference of project.references) {
      const target = args.workspace.projects.find((candidate) => pathsMatch(candidate.path, reference));
      if (target === undefined) continue;
      const targetId = projectIds.get(normalizePath(target.path));
      if (targetId === undefined || sourceId === targetId) continue;
      pushDepends(connections, seen, sourceId, targetId);
    }
  }

  const namespaceIds = new Map<string, string>();
  const fileIds = new Map<string, string>();
  for (const file of args.workspace.files) {
    const relative = slashRelative(args.rootPath, file.path);
    const fingerprint = hashFile(file.path);
    const projectKey = file.projectPath === null ? "" : slashRelative(args.rootPath, file.projectPath);
    const projectId = file.projectPath === null ? undefined : projectIds.get(normalizePath(file.projectPath));
    const namespaceId = file.namespace === ""
      ? undefined
      : ensureNamespace(blocks, connections, namespaceIds, projectKey, file.namespace, projectId ?? args.workspaceId, file.language, relative, fingerprint);
    const parent = namespaceId ?? projectId ?? args.workspaceId;
    const id = dotnetBlockId("file", [relative]);
    pushModule(blocks, connections, {
      id,
      label: path.basename(file.path) || relative,
      parent,
      packageName: packageNameFor(args.workspace, file),
      modulePath: relative,
      declaredBy: relative,
      cfgAttributes: file.imports.length === 0 ? ["file"] : file.imports.map((item) => item.statement),
      unresolved: file.unreadable,
      language: file.language,
      source: relative,
      fingerprint,
    });
    fileIds.set(normalizePath(file.path), id);
  }

  interface TypeRec {
    id: string;
    qualified: string;
    simple: string;
    language: string;
    kind: DotnetSymbolKind;
    partial: boolean;
    bases: string[];
    memberTypes: string[];
    files: string[];
    source: string;
    fingerprint: string;
    parent: string;
    packageName: string;
  }
  const types = new Map<string, TypeRec>();
  interface MethodRec {
    readonly name: string;
    readonly ownerKey: string;
    readonly line: number;
    readonly language: string;
    readonly source: string;
    readonly fingerprint: string;
    readonly packageName: string;
  }
  const methods: MethodRec[] = [];
  for (const file of args.workspace.files) {
    const relative = slashRelative(args.rootPath, file.path);
    const fingerprint = hashFile(file.path);
    const projectKey = file.projectPath === null ? "" : slashRelative(args.rootPath, file.projectPath);
    const packageName = packageNameFor(args.workspace, file);
    const fallback = fileIds.get(normalizePath(file.path)) ?? args.workspaceId;
    for (const symbol of file.symbols) {
      const ownerKey = `${projectKey}|${foldKey(symbol.qualified, file.language)}`;
      if (symbol.kind === "method") {
        methods.push({
          name: symbol.name,
          ownerKey,
          line: symbol.line,
          language: file.language,
          source: relative,
          fingerprint,
          packageName,
        });
        continue;
      }
      const parent = namespaceIds.get(namespaceKey(projectKey, symbol.namespace)) ?? fallback;
      const existing = types.get(ownerKey);
      if (existing !== undefined) {
        existing.partial = existing.partial || symbol.partial;
        existing.bases.push(...symbol.bases);
        existing.memberTypes.push(...symbol.memberTypes);
        existing.files.push(file.path);
        continue;
      }
      types.set(ownerKey, {
        id: dotnetBlockId("type", [projectKey, symbol.qualified]),
        qualified: symbol.qualified,
        simple: symbol.name,
        language: file.language,
        kind: symbol.kind,
        partial: symbol.partial,
        bases: [...symbol.bases],
        memberTypes: [...symbol.memberTypes],
        files: [file.path],
        source: relative,
        fingerprint,
        parent,
        packageName,
      });
    }
  }

  const exactTypes = new Map<string, string>();
  const foldedTypes = new Map<string, string[]>();
  const simpleExact = new Map<string, string[]>();
  const simpleFolded = new Map<string, string[]>();
  const ordered = [...types.entries()].sort((left, right) => compareText(left[0], right[0]));
  const typeByKey = new Map<string, TypeRec>();
  for (const [key, record] of ordered) {
    exactTypes.set(record.qualified, record.id);
    const folded = record.qualified.toLowerCase();
    foldedTypes.set(folded, [...(foldedTypes.get(folded) ?? []), record.id]);
    simpleExact.set(record.simple, [...(simpleExact.get(record.simple) ?? []), record.id]);
    const simpleFold = record.simple.toLowerCase();
    simpleFolded.set(simpleFold, [...(simpleFolded.get(simpleFold) ?? []), record.id]);
    typeByKey.set(key, record);
  }
  for (const [, record] of ordered) {
    pushModule(blocks, connections, {
      id: record.id,
      label: record.simple,
      parent: record.parent,
      packageName: record.packageName,
      modulePath: record.qualified,
      declaredBy: record.source,
      cfgAttributes: [cfgLabel(record.kind, record.partial || record.files.length > 1)],
      unresolved: false,
      language: record.language,
      source: record.source,
      fingerprint: record.fingerprint,
    });
    for (const filePath of record.files) {
      const fileId = fileIds.get(normalizePath(filePath));
      if (fileId === undefined || fileId === record.parent) continue;
      const edge = `contains:${fileId}->${record.id}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      connections.push(containsConnection(fileId, record.id));
    }
  }

  const methodIds: Array<{ readonly id: string; readonly method: MethodRec }> = [];
  for (const method of methods) {
    const owner = typeByKey.get(method.ownerKey);
    if (owner === undefined) continue;
    const id = dotnetBlockId("method", [owner.qualified, method.name, String(method.line)]);
    pushModule(blocks, connections, {
      id,
      label: method.name,
      parent: owner.id,
      packageName: method.packageName,
      modulePath: `${owner.qualified}.${method.name}`,
      declaredBy: method.source,
      cfgAttributes: ["method"],
      unresolved: false,
      language: method.language,
      source: method.source,
      fingerprint: method.fingerprint,
    });
    methodIds.push({ id, method });
  }

  const namespaceExact = new Map<string, string>();
  const namespaceFolded = new Map<string, string>();
  for (const [key, id] of namespaceIds) {
    const namespace = key.slice(key.indexOf("\0") + 1);
    namespaceExact.set(namespace, id);
    namespaceFolded.set(namespace.toLowerCase(), id);
  }

  for (const file of args.workspace.files) {
    const fileId = fileIds.get(normalizePath(file.path));
    if (fileId === undefined) continue;
    const fold = file.language === "vb";
    const aliases = new Map<string, string>();
    const imports: string[] = [];
    for (const other of importsFor(args.workspace, file)) {
      if (other.alias !== null) aliases.set(fold ? other.alias.toLowerCase() : other.alias, other.target);
      imports.push(other.target);
      const target = resolveName(other.target, fold, file.namespace, [], new Map(), exactTypes, foldedTypes, simpleExact, simpleFolded, namespaceExact, namespaceFolded);
      if (target !== null && target !== fileId) pushDepends(connections, seen, fileId, target);
    }
    for (const symbol of file.symbols) {
      const sourceId = symbol.kind === "method"
        ? methodIds.find((item) => item.method.name === symbol.name && item.method.line === symbol.line && item.method.source === slashRelative(args.rootPath, file.path))?.id
        : typeByKey.get(`${file.projectPath === null ? "" : slashRelative(args.rootPath, file.projectPath)}|${foldKey(symbol.qualified, file.language)}`)?.id;
      if (sourceId === undefined) continue;
      for (const name of [...symbol.bases, ...symbol.memberTypes]) {
        const target = resolveName(name, fold, symbol.namespace, imports, aliases, exactTypes, foldedTypes, simpleExact, simpleFolded, namespaceExact, namespaceFolded);
        if (target !== null && target !== sourceId) pushDepends(connections, seen, sourceId, target);
      }
    }
  }
  return { blocks, connections };
}

function fileFromPath(filePath: string, projects: readonly DotnetProject[]): DotnetFile {
  const language = extensionOf(filePath) === "vb" ? "vb" : "csharp";
  const projectPath = owningProject(filePath, projects)?.path ?? null;
  const bytes = readDotnetBytes(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { path: filePath, language, namespace: "", projectPath, unreadable: true, imports: [], symbols: [] };
  }
  const parsed = language === "vb" ? parseVbSource(text) : parseCsharpSource(text);
  const namespace = parsed.symbols.find((symbol) => symbol.kind !== "method")?.namespace
    ?? parsed.symbols[0]?.namespace
    ?? "";
  return { path: filePath, language, namespace, projectPath, unreadable: false, imports: parsed.imports, symbols: parsed.symbols };
}

function applyRootNamespace(file: DotnetFile, projects: readonly DotnetProject[]): DotnetFile {
  const project = file.projectPath === null ? undefined : projects.find((candidate) => pathsMatch(candidate.path, file.projectPath ?? ""));
  const root = project?.rootNamespace;
  if (root === undefined || root === null || root === "") return file;
  return {
    ...file,
    namespace: file.namespace === "" ? root : file.namespace,
    symbols: file.symbols.map((symbol) => {
      if (symbol.namespace !== "") return symbol;
      return { ...symbol, namespace: root, qualified: `${root}.${symbol.qualified}` };
    }),
  };
}

function owningProject(filePath: string, projects: readonly DotnetProject[]): DotnetProject | undefined {
  let best: DotnetProject | undefined;
  let bestLength = 0;
  for (const project of projects) {
    const directory = path.dirname(project.path);
    if (!isWithin(filePath, directory)) continue;
    const length = normalizePath(directory).split("/").filter((part) => part.length > 0).length;
    if (best === undefined || length > bestLength) {
      best = project;
      bestLength = length;
    }
  }
  return best;
}

function projectFromFile(filePath: string): DotnetProject {
  const text = readDotnetText(filePath);
  const language = extensionOf(filePath) === "vbproj" ? "vb" : "csharp";
  const assembly = xmlText(text, "AssemblyName");
  const stem = path.basename(filePath, path.extname(filePath));
  const name = assembly ?? (stem === "" ? "project" : stem);
  const references = xmlAttrValues(text, "ProjectReference", "Include").map((include) => portableJoin(path.dirname(filePath), include));
  return { name, path: filePath, language, rootNamespace: xmlText(text, "RootNamespace"), references };
}

function xmlText(text: string, element: string): string | null {
  const open = `<${element}>`;
  const close = `</${element}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const from = start + open.length;
  const end = text.indexOf(close, from);
  if (end < 0) return null;
  const value = text.slice(from, end).trim();
  return value === "" ? null : value;
}

function xmlAttrValues(text: string, element: string, attr: string): string[] {
  const values: string[] = [];
  const needle = `<${element}`;
  let rest = text;
  while (rest.length > 0) {
    const index = rest.indexOf(needle);
    if (index < 0) break;
    rest = rest.slice(index + needle.length);
    const end = rest.indexOf(">");
    const tag = end < 0 ? rest : rest.slice(0, end);
    const attrNeedle = `${attr}="`;
    const start = tag.indexOf(attrNeedle);
    if (start >= 0) {
      const valueStart = start + attrNeedle.length;
      const valueEnd = tag.indexOf('"', valueStart);
      if (valueEnd >= 0) values.push(tag.slice(valueStart, valueEnd));
    }
    rest = end < 0 ? "" : rest.slice(end);
  }
  return values;
}

function walkDotnetFiles(directory: string, canonicalRoot: string, seen: Set<string>, files: string[]): void {
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
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name.toLowerCase())) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkDotnetFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!isDotnetFile(child) || !confined(child, canonicalRoot)) continue;
    files.push(child);
  }
}

function confined(filePath: string, canonicalRoot: string): boolean {
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

function isDotnetFile(filePath: string): boolean {
  return ["cs", "vb", "csproj", "vbproj", "sln"].includes(extensionOf(filePath));
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase();
}

function maskCsharp(source: string): string {
  const chars = Array.from(source);
  let out = "";
  let index = 0;
  const stack: MaskMode[] = [{ kind: "code" }];
  while (index < chars.length) {
    const current = chars[index] ?? "";
    const next = chars[index + 1];
    const mode = stack[stack.length - 1] ?? { kind: "code" };
    if (mode.kind === "code") {
      if (current === "/" && next === "/") {
        out += "  ";
        index += 2;
        stack.push({ kind: "line" });
        continue;
      }
      if (current === "/" && next === "*") {
        out += "  ";
        index += 2;
        stack.push({ kind: "block" });
        continue;
      }
      if (current === "'") {
        out += " ";
        index += 1;
        stack.push({ kind: "char", escape: false });
        continue;
      }
      const opened = openCsharpString(chars, index);
      if (opened !== null) {
        out += " ".repeat(opened.width);
        index += opened.width;
        stack.push(opened.mode);
        continue;
      }
      out += current;
      index += 1;
      continue;
    }
    if (mode.kind === "line") {
      out += current === "\n" ? "\n" : " ";
      index += 1;
      if (current === "\n") stack.pop();
      continue;
    }
    if (mode.kind === "block") {
      if (current === "*" && next === "/") {
        out += "  ";
        index += 2;
        stack.pop();
        continue;
      }
      out += current === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (mode.kind === "char") {
      out += current === "\n" ? "\n" : " ";
      index += 1;
      if (mode.escape) stack[stack.length - 1] = { kind: "char", escape: false };
      else if (current === "\\") stack[stack.length - 1] = { kind: "char", escape: true };
      else if (current === "'" || current === "\n") stack.pop();
      continue;
    }
    out += current === "\n" ? "\n" : " ";
    index += 1;
    if (mode.kind === "regular") {
      let nextMode: MaskMode = mode;
      let popped = false;
      if (mode.escape) nextMode = { ...mode, escape: false };
      else if (mode.nested) {
        if (current === "\\") nextMode = { ...mode, escape: true };
        else if (current === '"') nextMode = { ...mode, nested: false, escape: false };
      } else if (mode.braces > 0) {
        if (current === '"') nextMode = { ...mode, nested: true, escape: false };
        else if (current === "{") nextMode = { ...mode, braces: mode.braces + 1 };
        else if (current === "}") nextMode = { ...mode, braces: mode.braces - 1 };
      } else if (current === "\\") nextMode = { ...mode, escape: true };
      else if (current === '"' || current === "\n") {
        stack.pop();
        popped = true;
      } else if (mode.interpolated && current === "{") {
        if (next === "{") {
          out += " ";
          index += 1;
        } else nextMode = { ...mode, braces: 1 };
      }
      if (!popped && stack.length > 0) stack[stack.length - 1] = nextMode;
      continue;
    }
    if (mode.kind === "verbatim") {
      let nextMode: MaskMode = mode;
      let popped = false;
      if (mode.nested) {
        if (current === '"' && next === '"') {
          out += " ";
          index += 1;
        } else if (current === '"') nextMode = { ...mode, nested: false };
      } else if (mode.braces > 0) {
        if (current === '"') nextMode = { ...mode, nested: true };
        else if (current === "{") nextMode = { ...mode, braces: mode.braces + 1 };
        else if (current === "}") nextMode = { ...mode, braces: mode.braces - 1 };
      } else if (current === '"') {
        if (next === '"') {
          out += " ";
          index += 1;
        } else {
          stack.pop();
          popped = true;
        }
      } else if (mode.interpolated && current === "{" && mode.braces === 0) {
        if (next === "{") {
          out += " ";
          index += 1;
        } else nextMode = { ...mode, braces: 1 };
      }
      if (!popped && stack.length > 0) stack[stack.length - 1] = nextMode;
      continue;
    }
    if (mode.braces === 0 && !mode.nested && current === '"') {
      const count = countQuotes(chars, index - 1);
      if (count >= mode.quotes) {
        out = out.slice(0, -1) + " ".repeat(mode.quotes);
        index += mode.quotes - 1;
        stack.pop();
        continue;
      }
    }
    let nextMode: MaskMode = mode;
    if (mode.nested) {
      if (current === '"') nextMode = { ...mode, nested: false };
    } else if (mode.braces > 0) {
      if (current === '"') nextMode = { ...mode, nested: true };
      else if (current === "{") nextMode = { ...mode, braces: mode.braces + 1 };
      else if (current === "}") nextMode = { ...mode, braces: mode.braces - 1 };
    } else if (mode.interpolated && current === "{") {
      if (next === "{") {
        out += " ";
        index += 1;
      } else nextMode = { ...mode, braces: 1 };
    }
    if (stack.length > 0) stack[stack.length - 1] = nextMode;
  }
  return out;
}

function openCsharpString(chars: readonly string[], index: number): { readonly mode: MaskMode; readonly width: number } | null {
  const current = chars[index];
  const next = chars[index + 1];
  const third = chars[index + 2];
  if (current === "@" && next === "$" && third === '"') {
    return { mode: { kind: "verbatim", interpolated: true, braces: 0, nested: false }, width: 3 };
  }
  if (current === "@" && next === '"') {
    return { mode: { kind: "verbatim", interpolated: false, braces: 0, nested: false }, width: 2 };
  }
  if (current === "$" && next === "@" && third === '"') {
    return { mode: { kind: "verbatim", interpolated: true, braces: 0, nested: false }, width: 3 };
  }
  if (current !== "$" && current !== '"') return null;
  const quoteAt = current === "$" ? index + 1 : index;
  if (chars[quoteAt] !== '"') return null;
  const quotes = countQuotes(chars, quoteAt);
  const interpolated = current === "$";
  if (quotes >= 3) {
    return {
      mode: { kind: "raw", quotes, interpolated, braces: 0, nested: false },
      width: quoteAt - index + quotes,
    };
  }
  if (interpolated) return { mode: { kind: "regular", interpolated: true, braces: 0, nested: false, escape: false }, width: 2 };
  return { mode: { kind: "regular", interpolated: false, braces: 0, nested: false, escape: false }, width: 1 };
}

function countQuotes(chars: readonly string[], index: number): number {
  let count = 0;
  while (chars[index + count] === '"') count += 1;
  return count;
}

function maskVb(source: string): string {
  const chars = Array.from(source);
  let out = "";
  let index = 0;
  let inString = false;
  while (index < chars.length) {
    const current = chars[index] ?? "";
    if (inString) {
      out += current === "\n" ? "\n" : " ";
      if (current === '"') {
        if (chars[index + 1] === '"') {
          out += " ";
          index += 2;
          continue;
        }
        inString = false;
      }
      index += 1;
      continue;
    }
    if (current === '"') {
      inString = true;
      out += " ";
      index += 1;
      continue;
    }
    if (current === "'") {
      out += " ";
      index += 1;
      while (index < chars.length && chars[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    out += current;
    index += 1;
  }
  return out;
}

function parseCsharp(masked: string): { readonly imports: DotnetImport[]; readonly symbols: DotnetSymbol[] } {
  const imports: DotnetImport[] = [];
  const symbols: DotnetSymbol[] = [];
  let fileNamespace: string | null = null;
  const namespaces: NsFrame[] = [];
  const types: TypeFrame[] = [];
  let pending: { symbol: DotnetSymbol; kind: DotnetSymbolKind } | null = null;
  let pendingNamespace: string | null = null;
  let depth = 0;
  for (const [lineNo, line] of csharpLogicalLines(masked)) {
    const startDepth = depth;
    const trimmed = line.trim();
    if (pending !== null) {
      const waiting: { symbol: DotnetSymbol; kind: DotnetSymbolKind } = pending;
      pending = null;
      if (trimmed.startsWith("{") || trimmed.startsWith(":")) {
        const symbol: DotnetSymbol = waiting.symbol;
        if (trimmed.startsWith(":")) symbol.bases.push(...basesFromLine(line));
        if (line.includes("{")) {
          types.push({
            qualified: symbol.qualified,
            simple: symbol.name,
            kind: waiting.kind,
            endDepth: startDepth,
            bodyDepth: startDepth + 1,
          });
          symbols.push(symbol);
        } else {
          pending = { symbol, kind: waiting.kind };
          depth = braceDepth(line, depth);
          popFrames(types, namespaces, depth);
          continue;
        }
        depth = braceDepth(line, depth);
        popFrames(types, namespaces, depth);
        continue;
      }
      symbols.push(waiting.symbol);
    }
    let codeLine = line;
    if (pendingNamespace !== null) {
      const full = pendingNamespace;
      pendingNamespace = null;
      if (trimmed.startsWith("{")) {
        namespaces.push({ full, endDepth: startDepth });
        const brace = line.indexOf("{");
        if (brace >= 0) codeLine = line.slice(brace + 1);
      } else {
        fileNamespace = full;
      }
    }
    const codeTrimmed = codeLine.trim();
    if (codeTrimmed === "") {
      depth = braceDepth(line, depth);
      popFrames(types, namespaces, depth);
      continue;
    }
    const code = stripAttributes(codeTrimmed);
    const tokens = tokenize(code);
    const partial = tokens.includes("partial");
    const index = skipModifiers(tokens);
    const currentNs = currentNamespace(fileNamespace, namespaces);
    if (tokens[index] === "#") {
      depth = braceDepth(line, depth);
      popFrames(types, namespaces, depth);
      continue;
    }
    const imported = csharpImport(tokens, index, lineNo);
    if (imported !== null) imports.push(imported);
    else if (tokens[index] === "namespace") {
      const name = dottedName(tokens, index + 1);
      if (name !== null) {
        const full = joinNamespace(currentNs, name);
        if (codeLine.includes(";") && !codeLine.includes("{")) fileNamespace = full;
        else if (codeLine.includes("{")) namespaces.push({ full, endDepth: startDepth });
        else pendingNamespace = full;
      }
    } else {
      const declared = csharpType(tokens, index, partial, lineNo, currentNs, types[types.length - 1]);
      if (declared !== null) {
        if (codeLine.includes("{")) {
          types.push({
            qualified: declared.qualified,
            simple: declared.name,
            kind: declared.kind,
            endDepth: startDepth,
            bodyDepth: startDepth + 1,
          });
          symbols.push(declared);
        } else if (codeLine.includes(";")) symbols.push(declared);
        else pending = { kind: declared.kind, symbol: declared };
      } else if (types.length > 0) {
        const frame = types[types.length - 1];
        if (frame !== undefined && allowsMembers(frame.kind) && startDepth === frame.bodyDepth) {
          const member = csharpMember(tokens, index, lineNo, frame, currentNs);
          if (member !== null) {
            if (member.kind === "method") symbols.push(member);
            else {
              const owner = [...symbols].reverse().find((symbol) => symbol.kind !== "method" && symbol.qualified === frame.qualified);
              owner?.memberTypes.push(...member.memberTypes);
            }
          }
        }
      }
    }
    depth = braceDepth(line, depth);
    popFrames(types, namespaces, depth);
  }
  if (pending !== null) symbols.push(pending.symbol);
  return { imports, symbols };
}

function csharpLogicalLines(masked: string): Array<[number, string]> {
  const raw = masked.split("\n");
  const lines: Array<[number, string]> = [];
  let index = 0;
  while (index < raw.length) {
    const start = index + 1;
    let combined = (raw[index] ?? "").replace(/\r$/, "");
    index += 1;
    while (true) {
      const angles = countChar(combined, "<") - countChar(combined, ">");
      const parens = countChar(combined, "(") - countChar(combined, ")");
      const trimmed = combined.trim();
      const hanging = trimmed.endsWith(":") || trimmed.endsWith(",") || angles > 0 || parens > 0;
      if (!hanging || index >= raw.length) break;
      combined += ` ${(raw[index] ?? "").replace(/\r$/, "")}`;
      index += 1;
    }
    lines.push([start, combined]);
  }
  return lines;
}

function popFrames(types: TypeFrame[], namespaces: NsFrame[], depth: number): void {
  while (types.length > 0 && depth <= (types[types.length - 1]?.endDepth ?? -1)) types.pop();
  while (namespaces.length > 0 && depth <= (namespaces[namespaces.length - 1]?.endDepth ?? -1)) namespaces.pop();
}

function braceDepth(line: string, depth: number): number {
  let next = depth;
  for (const character of line) {
    if (character === "{") next += 1;
    else if (character === "}") next -= 1;
  }
  return Math.max(0, next);
}

function currentNamespace(fileNamespace: string | null, namespaces: readonly NsFrame[]): string {
  return namespaces[namespaces.length - 1]?.full ?? fileNamespace ?? "";
}

function joinNamespace(parent: string, declared: string): string {
  if (parent === "") return declared;
  if (declared === "") return parent;
  return `${parent}.${declared}`;
}

function csharpImport(tokens: readonly string[], index: number, line: number): DotnetImport | null {
  let cursor = index;
  let global = false;
  if (tokens[cursor] === "global" && tokens[cursor + 1] === "using") {
    global = true;
    cursor += 1;
  }
  if (tokens[cursor] !== "using") return null;
  if (tokens[cursor + 1] === "(" || tokens[cursor + 1] === "var") return null;
  cursor += 1;
  let staticImport = false;
  if (tokens[cursor] === "static") {
    staticImport = true;
    cursor += 1;
  }
  const target = dottedName(tokens, cursor);
  if (target === null) return null;
  const after = cursor + target.split(".").length * 2 - 1;
  if (tokens[after] === "=") {
    const real = dottedName(tokens, after + 1);
    if (real === null) return null;
    const statement = global ? `global using ${target} = ${real}` : `using ${target} = ${real}`;
    return { line, target: real, alias: target, global, statement };
  }
  let statement = `using ${target}`;
  if (global && staticImport) statement = `global using static ${target}`;
  else if (global) statement = `global using ${target}`;
  else if (staticImport) statement = `using static ${target}`;
  return { line, target, alias: null, global, statement };
}

function csharpType(
  tokens: readonly string[],
  index: number,
  partial: boolean,
  line: number,
  namespace: string,
  owner: TypeFrame | undefined,
): DotnetSymbol | null {
  let cursor = index;
  let kind: DotnetSymbolKind;
  if (tokens[cursor] === "class") kind = "class";
  else if (tokens[cursor] === "struct") kind = "struct";
  else if (tokens[cursor] === "interface") kind = "interface";
  else if (tokens[cursor] === "enum") kind = "enum";
  else if (tokens[cursor] === "record") {
    if (tokens[cursor + 1] === "struct" || tokens[cursor + 1] === "class") cursor += 1;
    kind = "record";
  } else return null;
  cursor += 1;
  const name = tokens[cursor];
  if (name === undefined || !isIdent(name)) return null;
  cursor += 1;
  if (tokens[cursor] === "<") cursor = skipNest(tokens, cursor, "<", ">");
  const memberTypes: string[] = [];
  if (tokens[cursor] === "(") {
    const end = skipNest(tokens, cursor, "(", ")");
    memberTypes.push(...typeNames(tokens.slice(cursor + 1, Math.max(cursor + 1, end - 1))));
    cursor = end;
  }
  const bases: string[] = [];
  if (tokens[cursor] === ":") {
    const rest = tokens.slice(cursor + 1);
    const stop = rest.findIndex((token) => token === "{" || token === "where" || token === ";");
    bases.push(...typeNames(rest.slice(0, stop < 0 ? rest.length : stop)));
  }
  return {
    name,
    qualified: qualify(namespace, owner?.qualified, name),
    kind,
    line,
    namespace,
    partial,
    bases,
    memberTypes,
  };
}

function csharpMember(tokens: readonly string[], index: number, line: number, owner: TypeFrame, namespace: string): DotnetSymbol | null {
  const head = tokens[index];
  if (head === undefined || isControl(head)) return null;
  const paren = tokens.indexOf("(");
  const brace = tokens.indexOf("{");
  const isMethod = paren >= 0 && (brace < 0 || paren < brace);
  if (isMethod) {
    if (paren === 0) return null;
    const name = tokens[paren - 1];
    if (name === undefined || !isIdent(name) || isControl(name)) return null;
    const memberTypes = typeNames(tokens.slice(index, Math.max(index, paren - 1)));
    const end = skipNest(tokens, paren, "(", ")");
    memberTypes.push(...typeNames(tokens.slice(paren + 1, Math.max(paren + 1, end - 1))));
    return { name, qualified: owner.qualified, kind: "method", line, namespace, partial: false, bases: [], memberTypes };
  }
  const terminator = tokens.findIndex((token) => token === "{" || token === ";" || token === "=");
  const end = terminator < 0 ? tokens.length : terminator;
  if (end === 0) return null;
  let nameAt = -1;
  for (let cursor = end - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if (token !== undefined && isIdent(token)) {
      nameAt = cursor;
      break;
    }
  }
  if (nameAt < 0) return null;
  return memberTypeSymbol(tokens.slice(index, nameAt), owner, namespace, line);
}

function memberTypeSymbol(typeTokens: readonly string[], owner: TypeFrame, namespace: string, line: number): DotnetSymbol | null {
  const memberTypes = typeNames(typeTokens);
  if (memberTypes.length === 0) return null;
  return {
    name: owner.simple,
    qualified: owner.qualified,
    kind: owner.kind,
    line,
    namespace,
    partial: false,
    bases: [],
    memberTypes,
  };
}

function basesFromLine(line: string): string[] {
  const code = stripAttributes(line.trim().replace(/^:/, "").trim());
  const tokens = tokenize(code);
  const stop = tokens.findIndex((token) => token === "{" || token === "where");
  return typeNames(tokens.slice(0, stop < 0 ? tokens.length : stop));
}

function parseVb(masked: string): { readonly imports: DotnetImport[]; readonly symbols: DotnetSymbol[] } {
  const imports: DotnetImport[] = [];
  const symbols: DotnetSymbol[] = [];
  const namespaces: string[] = [];
  const types: string[] = [];
  const typeKinds: DotnetSymbolKind[] = [];
  let inMethod = 0;
  for (const [offset, raw] of vbLogicalLines(masked).entries()) {
    const lineNo = offset + 1;
    const tokens = tokenize(raw.trim());
    if (tokens.length === 0) continue;
    const lower = tokens.map((token) => token.toLowerCase());
    if (lower[0] === "end") {
      const kind = lower[1];
      if (kind === "namespace") namespaces.pop();
      else if (kind === "class" || kind === "structure" || kind === "interface" || kind === "module" || kind === "enum") {
        types.pop();
        typeKinds.pop();
      } else if (kind === "sub" || kind === "function") inMethod = Math.max(0, inMethod - 1);
      continue;
    }
    if (lower[0] === "imports") {
      const imported = vbImport(tokens, lower, lineNo);
      if (imported !== null) imports.push(imported);
      continue;
    }
    if (lower[0] === "namespace") {
      const name = dottedName(tokens, 1);
      if (name !== null) namespaces.push(joinNamespace(namespaces[namespaces.length - 1] ?? "", name));
      continue;
    }
    if (lower[0] === "inherits" || lower[0] === "implements") {
      const bases = typeNames(tokens.slice(1));
      const owner = types[types.length - 1];
      const symbol = [...symbols].reverse().find((item) => item.kind !== "method" && item.qualified === owner);
      symbol?.bases.push(...bases);
      continue;
    }
    const kindAt = lower.findIndex((token) => token === "class" || token === "structure" || token === "interface" || token === "module" || token === "enum");
    if (kindAt >= 0) {
      const head = lower[0];
      if (kindAt > 0 && head !== undefined && isControl(head)) continue;
      const keyword = lower[kindAt];
      const kind = keyword === "class" ? "class"
        : keyword === "structure" ? "struct"
          : keyword === "interface" ? "interface"
            : keyword === "module" ? "module"
              : keyword === "enum" ? "enum"
                : null;
      const name = tokens[kindAt + 1];
      if (kind === null || name === undefined || !isIdent(name) || lower.slice(0, kindAt).includes("end")) continue;
      const namespace = namespaces[namespaces.length - 1] ?? "";
      const owner = types[types.length - 1];
      const qualified = qualify(namespace, owner, name);
      symbols.push({
        name,
        qualified,
        kind,
        line: lineNo,
        namespace,
        partial: lower.includes("partial"),
        bases: [],
        memberTypes: [],
      });
      types.push(qualified);
      typeKinds.push(kind);
      continue;
    }
    const inType = allowsMembers(typeKinds[typeKinds.length - 1] ?? "method");
    if (!inType || inMethod > 0) continue;
    const memberAt = lower.findIndex((token) => token === "sub" || token === "function");
    if (memberAt >= 0) {
      const name = tokens[memberAt + 1];
      if (name === undefined || !isIdent(name)) continue;
      const memberTypes: string[] = [];
      const paren = tokens.indexOf("(");
      if (paren >= 0) {
        const end = skipNest(tokens, paren, "(", ")");
        memberTypes.push(...vbParamTypes(tokens.slice(paren + 1, Math.max(paren + 1, end - 1))));
        if (lower[memberAt] === "function") {
          let asAt = -1;
          for (let cursor = lower.length - 1; cursor >= 0; cursor -= 1) {
            if (lower[cursor] === "as") {
              asAt = cursor;
              break;
            }
          }
          if (asAt > paren) memberTypes.push(...typeNames(tokens.slice(asAt + 1)));
        }
      }
      symbols.push({
        name,
        qualified: types[types.length - 1] ?? "",
        kind: "method",
        line: lineNo,
        namespace: namespaces[namespaces.length - 1] ?? "",
        partial: false,
        bases: [],
        memberTypes,
      });
      inMethod += 1;
      continue;
    }
    const asAt = lower.indexOf("as");
    if (asAt >= 0) {
      const owner = types[types.length - 1];
      const symbol = [...symbols].reverse().find((item) => item.kind !== "method" && item.qualified === owner);
      symbol?.memberTypes.push(...typeNames(tokens.slice(asAt + 1)));
    }
  }
  return { imports, symbols };
}

function vbLogicalLines(masked: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const raw of masked.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const continued = line.trimEnd().endsWith(" _");
    const piece = continued ? line.trimEnd().replace(/_$/, "").trimEnd() : line;
    if (current !== "") current += " ";
    current += piece;
    if (!continued) {
      lines.push(current);
      current = "";
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function vbImport(tokens: readonly string[], lower: readonly string[], line: number): DotnetImport | null {
  let index = 1;
  if (lower[index] === "global") index += 1;
  const target = dottedName(tokens, index);
  if (target === null) return null;
  const after = index + (target.match(/\./g)?.length ?? 0) + 1;
  const global = lower[1] === "global";
  if (tokens[after] === "=") {
    const real = dottedName(tokens, after + 1);
    if (real === null) return null;
    return { line, alias: target, target: real, global, statement: `Imports ${target} = ${real}` };
  }
  return { line, target, alias: null, global, statement: `Imports ${target}` };
}

function vbParamTypes(tokens: readonly string[]): string[] {
  const types: string[] = [];
  let current: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth += 1;
    else if (token === ")") depth -= 1;
    if (token === "," && depth === 0) {
      types.push(...asType(current));
      current = [];
    } else current.push(token);
  }
  types.push(...asType(current));
  return types;
}

function asType(tokens: readonly string[]): string[] {
  const lower = tokens.map((token) => token.toLowerCase());
  const asAt = lower.indexOf("as");
  if (asAt < 0) return [];
  return typeNames(tokens.slice(asAt + 1));
}

function qualify(namespace: string, owner: string | undefined, name: string): string {
  if (owner !== undefined) return `${owner}.${name}`;
  if (namespace === "") return name;
  return `${namespace}.${name}`;
}

const modifiers = new Set([
  "public", "private", "protected", "internal", "static", "abstract", "sealed", "partial", "readonly",
  "ref", "file", "unsafe", "new", "virtual", "override", "async", "extern", "volatile", "required",
  "const", "fixed", "friend", "shared", "overrides", "overridable", "mustoverride", "notinheritable",
  "mustinherit", "writeonly", "withevents", "shadows", "overloads", "dim", "iterator",
]);

function skipModifiers(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length && modifiers.has(tokens[index] ?? "")) index += 1;
  return index;
}

function isControl(token: string): boolean {
  return ["if", "for", "foreach", "while", "switch", "lock", "using", "fixed", "catch", "else", "do", "return", "throw", "new", "try", "checked", "unchecked", "var", "when", "case"].includes(token);
}

function isIdent(token: string): boolean {
  return /^[@_\p{L}][@_\p{L}\p{N}]*$/u.test(token);
}

function dottedName(tokens: readonly string[], start: number): string | null {
  const head = tokens[start];
  if (head === undefined || !isIdent(head)) return null;
  let name = head;
  let index = start + 1;
  while (tokens[index] === "." && tokens[index + 1] !== undefined && isIdent(tokens[index + 1] ?? "")) {
    name += `.${tokens[index + 1]}`;
    index += 2;
  }
  return name;
}

function skipNest(tokens: readonly string[], start: number, open: string, close: string): number {
  let depth = 0;
  for (let offset = start; offset < tokens.length; offset += 1) {
    const token = tokens[offset];
    if (token === open) depth += 1;
    else if (token === close) {
      depth -= 1;
      if (depth === 0) return offset + 1;
    }
  }
  return tokens.length;
}

function typeNames(tokens: readonly string[]): string[] {
  const names: string[] = [];
  let current = "";
  let angle = 0;
  const flush = () => {
    if (current !== "") names.push(current);
    current = "";
  };
  for (const token of tokens) {
    if (token === "<") {
      if (angle === 0) flush();
      angle += 1;
      continue;
    }
    if (token === ">") {
      angle = Math.max(0, angle - 1);
      continue;
    }
    if (angle > 0) {
      if (isIdent(token)) names.push(token);
      continue;
    }
    if (token === ",") {
      flush();
      continue;
    }
    if (token === "[" || token === "]" || token === "?" || token === "(" || token === ")") continue;
    if (token === ".") {
      if (current !== "") current += ".";
      continue;
    }
    if (!isIdent(token)) continue;
    if (current.endsWith(".") || current === "") current += token;
    else {
      flush();
      current = token;
    }
  }
  flush();
  return names;
}

function stripAttributes(line: string): string {
  let out = "";
  let depth = 0;
  for (const character of line) {
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character === "]" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += character;
  }
  return out;
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const character of line) {
    if (character === "_" || character === "@" || /[\p{L}\p{N}]/u.test(character)) current += character;
    else {
      if (current !== "") tokens.push(current);
      current = "";
      if (!/\s/.test(character)) tokens.push(character);
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function packageNameFor(workspace: DotnetWorkspace, file: DotnetFile): string {
  if (file.projectPath === null) return "dotnet";
  return workspace.projects.find((project) => pathsMatch(project.path, file.projectPath ?? ""))?.name ?? "dotnet";
}

function importsFor(workspace: DotnetWorkspace, file: DotnetFile): DotnetImport[] {
  const imports = [...file.imports];
  for (const other of workspace.files) {
    if (!sameProject(file, other)) continue;
    for (const item of other.imports) {
      if (item.global && !file.imports.some((owned) => owned.statement === item.statement)) imports.push(item);
    }
  }
  return imports;
}

function sameProject(left: DotnetFile, right: DotnetFile): boolean {
  if (left.projectPath === null || right.projectPath === null) return false;
  return pathsMatch(left.projectPath, right.projectPath);
}

function ensureNamespace(
  blocks: ModuleBlock[],
  connections: FactConnection[],
  namespaceIds: Map<string, string>,
  projectKey: string,
  namespace: string,
  parent: string,
  language: string,
  source: string,
  fingerprint: string,
): string {
  const key = namespaceKey(projectKey, namespace);
  const existing = namespaceIds.get(key);
  if (existing !== undefined) return existing;
  const id = dotnetBlockId("namespace", [projectKey, namespace]);
  const label = namespace.split(".").pop() ?? namespace;
  pushModule(blocks, connections, {
    id,
    label,
    parent,
    packageName: namespace,
    modulePath: namespace,
    declaredBy: source,
    cfgAttributes: ["namespace"],
    unresolved: false,
    language,
    source,
    fingerprint,
  });
  namespaceIds.set(key, id);
  return id;
}

function namespaceKey(projectKey: string, namespace: string): string {
  return `${projectKey}\0${namespace}`;
}

function foldKey(qualified: string, language: string): string {
  return language === "vb" ? qualified.toLowerCase() : qualified;
}

function dotnetBlockId(kind: string, parts: readonly string[]): string {
  let id = `module:dotnet:${kind}`;
  for (const part of parts) {
    const slugged = slug(part);
    id += `:${slugged === "" ? "global" : slugged}`;
  }
  return id;
}

function cfgLabel(kind: DotnetSymbolKind, partial: boolean): string {
  if (kind === "class" && partial) return "partial class";
  return kind;
}

function allowsMembers(kind: DotnetSymbolKind): boolean {
  return kind === "class" || kind === "struct" || kind === "record" || kind === "interface" || kind === "module";
}

function pushModule(blocks: ModuleBlock[], connections: FactConnection[], args: {
  readonly id: string;
  readonly label: string;
  readonly parent: string;
  readonly packageName: string;
  readonly modulePath: string;
  readonly declaredBy: string;
  readonly cfgAttributes: readonly string[];
  readonly unresolved: boolean;
  readonly language: string;
  readonly source: string;
  readonly fingerprint: string;
}): void {
  blocks.push({
    id: args.id,
    label: args.label,
    type: "module",
    packageName: args.packageName,
    modulePath: args.modulePath,
    declaredByPath: args.declaredBy,
    cfgAttributes: args.cfgAttributes,
    unresolved: args.unresolved,
    language: args.language,
    parentId: args.parent,
    children: [],
    sourcePath: args.source,
    fingerprint: args.fingerprint,
  });
  connections.push(containsConnection(args.parent, args.id));
}

function pushDepends(connections: FactConnection[], seen: Set<string>, source: string, target: string): void {
  const id = `depends_on:${source}->${target}`;
  if (seen.has(id)) return;
  seen.add(id);
  connections.push({ id, source, target, kind: "depends_on", dependencyScope: "normal" });
}

function containsConnection(source: string, target: string): FactConnection {
  return { id: `contains:${source}->${target}`, source, target, kind: "contains" };
}

function resolveName(
  raw: string,
  fold: boolean,
  namespace: string,
  imports: readonly string[],
  aliases: ReadonlyMap<string, string>,
  exactTypes: ReadonlyMap<string, string>,
  foldedTypes: ReadonlyMap<string, readonly string[]>,
  simpleExact: ReadonlyMap<string, readonly string[]>,
  simpleFolded: ReadonlyMap<string, readonly string[]>,
  namespaceExact: ReadonlyMap<string, string>,
  namespaceFolded: ReadonlyMap<string, string>,
): string | null {
  let name = raw.trim().replace(/^global::/, "").replace(/\?$/, "");
  if (name === "" || isPrimitive(name)) return null;
  const aliasKey = fold ? name.toLowerCase() : name;
  const aliased = aliases.get(aliasKey);
  if (aliased !== undefined) name = aliased;
  else {
    const dot = name.indexOf(".");
    if (dot >= 0) {
      const head = name.slice(0, dot);
      const tail = name.slice(dot + 1);
      const headAlias = aliases.get(fold ? head.toLowerCase() : head);
      if (headAlias !== undefined) name = `${headAlias}.${tail}`;
    }
  }
  const qualified = lookupQualified(name, fold, exactTypes, foldedTypes, namespaceExact, namespaceFolded);
  if (qualified !== null) return qualified;
  if (!name.includes(".")) {
    const inNamespace = namespace === "" ? name : `${namespace}.${name}`;
    const found = lookupQualified(inNamespace, fold, exactTypes, foldedTypes, namespaceExact, namespaceFolded);
    if (found !== null) return found;
    for (const imported of imports) {
      const candidate = lookupQualified(`${imported}.${name}`, fold, exactTypes, foldedTypes, namespaceExact, namespaceFolded);
      if (candidate !== null) return candidate;
    }
    return unique(fold ? simpleFolded.get(name.toLowerCase()) : simpleExact.get(name));
  }
  return null;
}

function lookupQualified(
  name: string,
  fold: boolean,
  exactTypes: ReadonlyMap<string, string>,
  foldedTypes: ReadonlyMap<string, readonly string[]>,
  namespaceExact: ReadonlyMap<string, string>,
  namespaceFolded: ReadonlyMap<string, string>,
): string | null {
  if (fold) return unique(foldedTypes.get(name.toLowerCase())) ?? namespaceFolded.get(name.toLowerCase()) ?? null;
  return exactTypes.get(name) ?? namespaceExact.get(name) ?? null;
}

function unique(values: readonly string[] | undefined): string | null {
  if (values === undefined || values.length !== 1) return null;
  return values[0] ?? null;
}

function isPrimitive(name: string): boolean {
  return ["void", "int", "string", "bool", "boolean", "byte", "char", "decimal", "double", "float", "long", "short", "object", "uint", "ulong", "ushort", "nint", "nuint", "dynamic", "var", "integer", "single", "date", "datetime"].includes(name.toLowerCase());
}

function pathsMatch(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (a === b) return true;
  return fileName(a) === fileName(b) && parentName(a) === parentName(b);
}

function fileName(value: string): string {
  return value.split("/").pop() ?? "";
}

function parentName(value: string): string {
  const parts = value.split("/");
  return parts.length < 2 ? "" : parts[parts.length - 2] ?? "";
}

function isWithin(filePath: string, directory: string): boolean {
  const file = normalizePath(filePath);
  const dir = normalizePath(directory);
  return file === dir || file.startsWith(`${dir}/`);
}

function portableJoin(base: string, relative: string): string {
  const normalized = normalizePath(base);
  const absolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  for (const part of relative.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}

function normalizePath(value: string): string {
  const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  const parts: string[] = [];
  for (const part of value.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (/^[A-Za-z]:/.test(value)) return `${value.slice(0, 2)}/${joined.slice(joined.indexOf("/") + 1)}`;
  return absolute ? `/${joined}` : joined;
}

function slashRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readDotnetBytes(filePath: string): Uint8Array {
  try {
    return readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    throw new Error(`Could not read .NET source ${filePath}: ${message}`);
  }
}

function readDotnetText(filePath: string): string {
  const bytes = readDotnetBytes(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Could not read .NET source ${filePath}: invalid UTF-8`);
  }
}

function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function countChar(value: string, character: string): number {
  return value.split(character).length - 1;
}
