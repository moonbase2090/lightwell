import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isIgnoredDirectory } from "../workspace-ignore.js";
import type { FactConnection, ModuleBlock } from "../model.js";

export type GoSymbolKind = "func" | "method" | "type";

export interface GoImport {
  readonly line: number;
  readonly path: string;
  readonly alias: string | null;
}

export interface GoSymbol {
  readonly name: string;
  readonly kind: GoSymbolKind;
  readonly line: number;
  readonly receiver: string | null;
}

export interface GoCall {
  readonly line: number;
  readonly qualifier: string;
  readonly name: string;
}

export interface GoFile {
  readonly path: string;
  readonly test: boolean;
  readonly unreadable: boolean;
  readonly imports: readonly GoImport[];
  readonly symbols: readonly GoSymbol[];
  readonly calls: readonly GoCall[];
}

export interface GoPackage {
  readonly importPath: string;
  readonly name: string;
  readonly directory: string;
  readonly files: readonly GoFile[];
}

const skippedDirectories = ["vendor", "testdata"];

export function discoverGoPackages(repositoryPath: string): GoPackage[] {
  const root = path.resolve(repositoryPath);
  if (!existsSync(path.join(root, "go.mod"))) return [];
  const modulePath = readGoModulePath(root);
  const canonicalRoot = realpathSync(root);
  const directories = new Map<string, string[]>();
  walkGoFiles(root, canonicalRoot, new Set(), directories);
  const packages = [...directories.entries()]
    .map(([directory, files]) => packageFromDirectory(root, modulePath, directory, files))
    .sort((left, right) => left.importPath.localeCompare(right.importPath));
  return packages;
}

export function parseGoSource(source: string): {
  readonly imports: GoImport[];
  readonly symbols: GoSymbol[];
  readonly calls: GoCall[];
} {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const stripped = stripGoComments(normalized);
  const imports = parseImports(stripped);
  return {
    imports,
    symbols: parseSymbols(stripped),
    calls: parseCalls(stripped, imports),
  };
}

export function goImportAliasPaths(imports: readonly GoImport[]): Map<string, string> {
  const aliasToPath = new Map<string, string>();
  for (const importItem of imports) {
    if (importItem.alias === "_" || importItem.alias === ".") continue;
    const alias = importItem.alias ?? importItem.path.split("/").at(-1) ?? "";
    if (alias.length > 0) aliasToPath.set(alias, importItem.path);
  }
  return aliasToPath;
}

export function goImportStatement(item: GoImport): string {
  if (item.alias === null) return `import "${item.path}"`;
  return `import ${item.alias} "${item.path}"`;
}

export function goFactBlocks(args: {
  readonly packages: readonly GoPackage[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const packageIds = new Map(args.packages.map((pkg) => [pkg.importPath, goPackageBlockId(pkg.importPath)]));
  for (const pkg of args.packages) {
    const packageId = packageIds.get(pkg.importPath)!;
    const packageFingerprint = hashText(
      pkg.files.map((file) => hashFile(file.path)).sort().join("\n"),
    );
    const firstFile = pkg.files[0];
    blocks.push({
      id: packageId,
      label: pkg.name,
      type: "module",
      packageName: pkg.importPath,
      modulePath: pkg.importPath,
      declaredByPath: firstFile === undefined ? "" : toSlash(path.relative(args.rootPath, firstFile.path)),
      cfgAttributes: pkg.files.flatMap((file) => file.imports.map(goImportStatement)),
      unresolved: pkg.files.length > 0 && pkg.files.every((file) => file.unreadable),
      language: "go",
      parentId: args.workspaceId,
      children: [],
      sourcePath: firstFile === undefined ? null : toSlash(path.relative(args.rootPath, firstFile.path)),
      fingerprint: packageFingerprint,
    });
    connections.push(containsConnection(args.workspaceId, packageId));
    for (const file of pkg.files) {
      const stem = path.basename(file.path, ".go");
      const modulePath = `${pkg.importPath}/${stem}`;
      const fileId = goFileBlockId(modulePath, file.test);
      const relative = toSlash(path.relative(args.rootPath, file.path));
      const fingerprint = hashFile(file.path);
      blocks.push({
        id: fileId,
        label: stem,
        type: "module",
        packageName: pkg.importPath,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: file.imports.map(goImportStatement),
        unresolved: file.unreadable,
        language: "go",
        parentId: packageId,
        children: [],
        sourcePath: relative,
        fingerprint,
      });
      connections.push(containsConnection(packageId, fileId));
      for (const symbol of file.symbols) {
        const symbolModulePath = `${pkg.importPath}/${stem}.${symbol.name}`;
        const symbolId = goSymbolBlockId(symbolModulePath, symbol.kind);
        blocks.push({
          id: symbolId,
          label: symbol.name,
          type: "module",
          packageName: pkg.importPath,
          modulePath: symbolModulePath,
          declaredByPath: relative,
          cfgAttributes: [symbol.kind],
          unresolved: false,
          language: "go",
          parentId: fileId,
          children: [],
          sourcePath: relative,
          fingerprint,
        });
        connections.push(containsConnection(fileId, symbolId));
      }
    }
    const importEdges = new Set<string>();
    for (const file of pkg.files) {
      for (const importItem of file.imports) {
        const target = packageIds.get(importItem.path);
        if (target === undefined || target === packageId) continue;
        const id = connectionId("depends_on", packageId, target);
        if (importEdges.has(id)) continue;
        importEdges.add(id);
        connections.push({ id, source: packageId, target, kind: "depends_on", dependencyScope: "normal" });
      }
    }
  }
  appendGoCallConnections(args.packages, blocks, connections);
  return { blocks, connections };
}

function appendGoCallConnections(
  packages: readonly GoPackage[],
  blocks: readonly ModuleBlock[],
  connections: FactConnection[],
): void {
  const symbolIds = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "module" || block.language !== "go" || block.cfgAttributes.length !== 1) continue;
    const kind = block.cfgAttributes[0];
    if (kind !== "func" && kind !== "method" && kind !== "type") continue;
    symbolIds.set(`${block.packageName}\0${block.label}`, block.id);
  }
  const callEdges = new Set<string>();
  for (const pkg of packages) {
    for (const file of pkg.files) {
      if (file.unreadable) continue;
      const stem = path.basename(file.path, ".go");
      const modulePath = `${pkg.importPath}/${stem}`;
      const fileId = goFileBlockId(modulePath, file.test);
      const aliases = goImportAliasPaths(file.imports);
      for (const call of file.calls) {
        const importPath = aliases.get(call.qualifier);
        if (importPath === undefined) continue;
        const targetId = symbolIds.get(`${importPath}\0${call.name}`);
        if (targetId === undefined) continue;
        const id = connectionId("depends_on", fileId, targetId);
        if (callEdges.has(id)) continue;
        callEdges.add(id);
        connections.push({ id, source: fileId, target: targetId, kind: "depends_on", dependencyScope: "normal" });
      }
    }
  }
}

function readGoModulePath(root: string): string {
  const modPath = path.join(root, "go.mod");
  const contents = readFileSync(modPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = (line.split("//")[0] ?? "").trim();
    if (trimmed.startsWith("module ")) {
      const module = trimmed.slice("module ".length).trim().replace(/^"|"$/g, "");
      if (module.length > 0) return module;
    }
  }
  throw new Error(`go.mod has no module path at ${modPath}`);
}

function packageFromDirectory(root: string, modulePath: string, directory: string, files: string[]): GoPackage {
  const relative = toSlash(path.relative(root, directory));
  const importPath = relative.length === 0 ? modulePath : `${modulePath}/${relative}`;
  const sorted = [...files].sort();
  let packageName: string | null = null;
  const goFiles: GoFile[] = [];
  for (const filePath of sorted) {
    let source: string | null;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      goFiles.push({
        path: filePath,
        test: isTestFile(filePath),
        unreadable: true,
        imports: [],
        symbols: [],
        calls: [],
      });
      continue;
    }
    const clause = readPackageClause(source);
    if (clause !== null) packageName = clause;
    const parsed = parseGoSource(source);
    goFiles.push({
      path: filePath,
      test: isTestFile(filePath),
      unreadable: false,
      imports: parsed.imports,
      symbols: parsed.symbols,
      calls: parsed.calls,
    });
  }
  const name = packageName ?? path.basename(directory);
  return { importPath, name, directory, files: goFiles };
}

function walkGoFiles(
  directory: string,
  canonicalRoot: string,
  seen: Set<string>,
  packages: Map<string, string[]>,
): void {
  let canonical: string;
  try {
    canonical = realpathSync(directory);
  } catch {
    return;
  }
  if (!isConfined(canonicalRoot, canonical) || seen.has(canonical)) return;
  seen.add(canonical);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".") || isIgnoredDirectory(name, skippedDirectories)) continue;
    const child = path.join(directory, name);
    if (entry.isDirectory()) {
      walkGoFiles(child, canonicalRoot, seen, packages);
      continue;
    }
    if (!entry.isFile() || !name.endsWith(".go")) continue;
    if (!isConfined(canonicalRoot, realpathSync(child))) continue;
    const parent = path.dirname(child);
    const list = packages.get(parent) ?? [];
    list.push(child);
    packages.set(parent, list);
  }
}

function readPackageClause(source: string): string | null {
  for (const line of source.split("\n")) {
    const trimmed = (line.split("//")[0] ?? "").trim();
    if (trimmed.startsWith("package ")) {
      const name = trimmed.slice("package ".length).split(/\s+/)[0];
      return name ?? null;
    }
  }
  return null;
}

function stripGoComments(source: string): string {
  const chars = [...source];
  let index = 0;
  let out = "";
  while (index < chars.length) {
    if (chars[index] === "/" && index + 1 < chars.length && chars[index + 1] === "/") {
      while (index < chars.length && chars[index] !== "\n") index += 1;
      continue;
    }
    if (chars[index] === "/" && index + 1 < chars.length && chars[index + 1] === "*") {
      index += 2;
      while (index < chars.length) {
        if (index + 1 < chars.length && chars[index] === "*" && chars[index + 1] === "/") {
          index += 2;
          break;
        }
        if (chars[index] === "\n") out += "\n";
        index += 1;
      }
      continue;
    }
    if (chars[index] === '"' || chars[index] === "`") {
      const quote = chars[index];
      out += quote;
      index += 1;
      while (index < chars.length) {
        if (chars[index] === "\\" && quote !== "`") {
          out += chars[index];
          if (index + 1 < chars.length) out += chars[index + 1];
          index += 2;
          continue;
        }
        out += chars[index];
        if (chars[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (chars[index] === "'") {
      out += "'";
      index += 1;
      while (index < chars.length) {
        if (chars[index] === "\\") {
          out += chars[index];
          if (index + 1 < chars.length) out += chars[index + 1];
          index += 2;
          continue;
        }
        out += chars[index];
        if (chars[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += chars[index];
    index += 1;
  }
  return out;
}

function advanceSourceIndex(source: string, index: number): number {
  const codePoint = source.codePointAt(index);
  if (codePoint === undefined) return index;
  return index + (codePoint > 0xffff ? 2 : 1);
}

function parseImports(source: string): GoImport[] {
  const imports: GoImport[] = [];
  let lineNo = 1;
  let index = 0;
  while (index < source.length) {
    if (source[index] === "\n") {
      lineNo += 1;
      index += 1;
      continue;
    }
    if (source.startsWith("import ", index)) {
      const importStart = index + "import ".length;
      const rest = source.slice(importStart);
      const trimmed = rest.trimStart();
      if (trimmed.startsWith("(")) {
        const block = readParenBlock(trimmed);
        const consumed = block.text.length + (rest.length - trimmed.length);
        for (const entry of splitImportBlock(block.text)) {
          const importItem = parseImportEntry(entry, lineNo);
          if (importItem !== null) imports.push(importItem);
        }
        index = importStart + consumed;
        continue;
      }
      const entry = rest.split("\n")[0]?.trim() ?? "";
      const importItem = parseImportEntry(entry, lineNo);
      if (importItem !== null) imports.push(importItem);
      index = importStart + entry.length;
      continue;
    }
    index = advanceSourceIndex(source, index);
  }
  return imports;
}

function parseCalls(source: string, imports: readonly GoImport[]): GoCall[] {
  const aliases = goImportAliasPaths(imports);
  const calls: GoCall[] = [];
  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNo = lineIndex + 1;
    const line = lines[lineIndex] ?? "";
    for (const token of line.split(/[^a-zA-Z0-9_.]+/)) {
      if (!token.includes(".")) continue;
      const [qualifier, name] = token.split(".", 2);
      if (qualifier === undefined || name === undefined || qualifier.length === 0 || name.length === 0) continue;
      if (!/^[A-Z]/.test(name)) continue;
      if (!aliases.has(qualifier)) continue;
      calls.push({ line: lineNo, qualifier, name });
    }
  }
  return calls;
}

function readParenBlock(source: string): { readonly text: string } {
  let depth = 0;
  let out = "";
  for (const character of source) {
    out += character;
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { text: out };
}

function splitImportBlock(block: string): string[] {
  const inner = block.trim().replace(/^\(/, "").replace(/\)$/, "");
  return inner.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseImportEntry(entry: string, line: number): GoImport | null {
  const trimmed = entry.trim().replace(/;$/, "");
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('"')) {
    const pathValue = trimmed.replace(/^"/, "").split('"')[0] ?? "";
    if (pathValue.length === 0) return null;
    return { line, path: pathValue, alias: null };
  }
  const quote = trimmed.indexOf('"');
  if (quote < 0) return null;
  const aliasPart = trimmed.slice(0, quote).trim();
  const pathValue = trimmed.slice(quote + 1).split('"')[0] ?? "";
  if (pathValue.length === 0) return null;
  const alias = aliasPart.length === 0 || aliasPart === "." || aliasPart === "_" ? aliasPart || null : aliasPart;
  return { line, path: pathValue, alias };
}

function parseSymbols(source: string): GoSymbol[] {
  const symbols: GoSymbol[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("func ")) {
      const symbol = parseFuncLine(trimmed, lineNo);
      if (symbol !== null) symbols.push(symbol);
      continue;
    }
    if (trimmed.startsWith("type ")) {
      const name = trimmed.slice("type ".length).split(/\s+/)[0];
      if (name !== undefined && name.length > 0) {
        symbols.push({ name, kind: "type", line: lineNo, receiver: null });
      }
    }
  }
  return symbols;
}

function parseFuncLine(line: string, lineNo: number): GoSymbol | null {
  const rest = line.slice("func ".length);
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")");
    if (close < 0) return null;
    const receiver = rest.slice(1, close).trim();
    const receiverType = (receiver.split(/\s+/).at(-1) ?? receiver).replace(/^\*/, "");
    const after = rest.slice(close + 1).trim();
    const name = after.split("(")[0]?.trim() ?? "";
    if (name.length === 0) return null;
    return { name, kind: "method", line: lineNo, receiver: receiverType };
  }
  const name = rest.split("(")[0]?.trim() ?? "";
  if (name.length === 0) return null;
  return { name, kind: "func", line: lineNo, receiver: null };
}

function isTestFile(filePath: string): boolean {
  return path.basename(filePath, ".go").endsWith("_test");
}

function goPackageBlockId(importPath: string): string {
  return `module:go:${slug(importPath)}`;
}

function goFileBlockId(modulePath: string, test: boolean): string {
  return test ? `${goPackageBlockId(modulePath)}:test` : goPackageBlockId(modulePath);
}

function goSymbolBlockId(modulePath: string, kind: string): string {
  return `module:go:${slug(modulePath)}:${slug(kind)}`;
}

function containsConnection(source: string, target: string): FactConnection {
  return { id: connectionId("contains", source, target), source, target, kind: "contains" };
}

function connectionId(kind: "contains" | "depends_on", source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toSlash(value: string): string {
  return value.split(path.sep).join("/");
}
