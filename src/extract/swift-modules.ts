import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isIgnoredDirectory } from "../workspace-ignore.js";
import type { FactConnection, ModuleBlock } from "../model.js";

export type SwiftSymbolKind =
  | "struct"
  | "class"
  | "enum"
  | "protocol"
  | "actor"
  | "typealias"
  | "func"
  | "init";

export interface SwiftImport {
  readonly line: number;
  readonly module: string;
  readonly statement: string;
}

export interface SwiftSymbol {
  readonly name: string;
  readonly kind: SwiftSymbolKind;
  readonly line: number;
}

export interface SwiftFile {
  readonly path: string;
  readonly unreadable: boolean;
  readonly imports: readonly SwiftImport[];
  readonly symbols: readonly SwiftSymbol[];
}

export interface SwiftTarget {
  readonly name: string;
  readonly packageName: string;
  readonly directory: string;
  readonly files: readonly SwiftFile[];
}

const skippedDirectories = [
  "deriveddata",
  "vendor",
];

export function discoverSwiftTargets(repositoryPath: string): SwiftTarget[] {
  const root = path.resolve(repositoryPath);
  const packageSwift = path.join(root, "Package.swift");
  if (existsSync(packageSwift) && isFile(packageSwift)) {
    return discoverSwiftPm(root, packageSwift);
  }
  const xcodeproj = findXcodeproj(root);
  if (xcodeproj !== null) {
    return discoverXcode(root, xcodeproj);
  }
  return [];
}

export function parseSwiftSource(source: string): {
  readonly imports: SwiftImport[];
  readonly symbols: SwiftSymbol[];
} {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const stripped = stripSwiftComments(normalized);
  return {
    imports: parseImports(stripped),
    symbols: parseSymbols(stripped),
  };
}

export function swiftFactBlocks(args: {
  readonly targets: readonly SwiftTarget[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const targetIds = new Map(args.targets.map((target) => [target.name, swiftTargetBlockId(target.name)]));
  for (const target of args.targets) {
    const targetId = targetIds.get(target.name)!;
    const modulePath = `${target.packageName}/${target.name}`;
    const packageFingerprint = hashText(
      target.files.map((file) => hashFile(file.path)).sort().join("\n"),
    );
    const firstFile = target.files[0];
    blocks.push({
      id: targetId,
      label: target.name,
      type: "module",
      packageName: target.packageName,
      modulePath,
      declaredByPath: toSlash(path.relative(args.rootPath, target.directory)),
      cfgAttributes: target.files.flatMap((file) => file.imports.map((item) => item.statement)),
      unresolved: target.files.length > 0 && target.files.every((file) => file.unreadable),
      language: "swift",
      parentId: args.workspaceId,
      children: [],
      sourcePath: firstFile === undefined ? null : toSlash(path.relative(args.rootPath, firstFile.path)),
      fingerprint: packageFingerprint,
    });
    connections.push(containsConnection(args.workspaceId, targetId));
    for (const file of target.files) {
      const stem = path.basename(file.path, ".swift");
      const fileModulePath = `${target.packageName}/${target.name}/${stem}`;
      const fileId = swiftFileBlockId(fileModulePath);
      const relative = toSlash(path.relative(args.rootPath, file.path));
      const fingerprint = hashFile(file.path);
      blocks.push({
        id: fileId,
        label: stem,
        type: "module",
        packageName: target.packageName,
        modulePath: fileModulePath,
        declaredByPath: relative,
        cfgAttributes: file.imports.map((item) => item.statement),
        unresolved: file.unreadable,
        language: "swift",
        parentId: targetId,
        children: [],
        sourcePath: relative,
        fingerprint,
      });
      connections.push(containsConnection(targetId, fileId));
      for (const symbol of file.symbols) {
        const symbolModulePath = `${target.packageName}/${target.name}/${stem}.${symbol.name}`;
        const symbolId = swiftSymbolBlockId(symbolModulePath, symbol.kind);
        blocks.push({
          id: symbolId,
          label: symbol.name,
          type: "module",
          packageName: target.packageName,
          modulePath: symbolModulePath,
          declaredByPath: relative,
          cfgAttributes: [symbol.kind],
          unresolved: false,
          language: "swift",
          parentId: fileId,
          children: [],
          sourcePath: relative,
          fingerprint,
        });
        connections.push(containsConnection(fileId, symbolId));
      }
    }
    const importEdges = new Set<string>();
    for (const file of target.files) {
      for (const importItem of file.imports) {
        const dest = targetIds.get(importItem.module);
        if (dest === undefined || dest === targetId) continue;
        const id = connectionId("depends_on", targetId, dest);
        if (importEdges.has(id)) continue;
        importEdges.add(id);
        connections.push({ id, source: targetId, target: dest, kind: "depends_on", dependencyScope: "normal" });
      }
    }
  }
  return { blocks, connections };
}

function discoverSwiftPm(root: string, packageSwift: string): SwiftTarget[] {
  const contents = readFileSync(packageSwift, "utf8");
  const packageName = parsePackageName(contents) ?? path.basename(root);
  const targetNames = parseTargetNames(contents);
  if (targetNames.length === 0) return [];
  const sourcesRoot = path.join(root, "Sources");
  const canonicalRoot = safeRealpath(root) ?? root;
  const claimed = new Set<string>();
  const targets: Array<{
    name: string;
    packageName: string;
    directory: string;
    files: SwiftFile[];
  }> = [];
  for (const targetName of targetNames) {
    const targetDir = path.join(sourcesRoot, targetName);
    const testsDir = path.join(root, "Tests", targetName);
    const filePaths: string[] = [];
    if (isDirectory(targetDir)) collectSwiftFiles(targetDir, canonicalRoot, filePaths);
    if (isDirectory(testsDir)) collectSwiftFiles(testsDir, canonicalRoot, filePaths);
    const directory = isDirectory(targetDir) ? targetDir : isDirectory(testsDir) ? testsDir : sourcesRoot;
    for (const filePath of filePaths) claimed.add(filePath);
    filePaths.sort();
    targets.push({
      name: targetName,
      packageName,
      directory,
      files: loadSwiftFiles(filePaths),
    });
  }
  if (isDirectory(sourcesRoot)) {
    const loose: string[] = [];
    collectSwiftFilesShallow(sourcesRoot, canonicalRoot, loose);
    const leftover = loose.filter((filePath) => !claimed.has(filePath)).sort();
    if (leftover.length > 0) {
      const host =
        targets.find((target) => (!target.name.endsWith("Tests") && target.directory === sourcesRoot) || target.files.length === 0)
        ?? targets[0];
      if (host !== undefined) {
        host.files = [...host.files, ...loadSwiftFiles(leftover)].sort((left, right) => left.path.localeCompare(right.path));
      }
    }
  }
  return targets.sort((left, right) => left.name.localeCompare(right.name));
}

function discoverXcode(root: string, project: string): SwiftTarget[] {
  const projectStem = path.basename(project, ".xcodeproj");
  const canonicalRoot = safeRealpath(root) ?? root;
  const byDir = new Map<string, string[]>();
  walkSwiftFiles(root, canonicalRoot, byDir);
  const targets: SwiftTarget[] = [];
  for (const [directory, files] of byDir) {
    const sorted = [...files].sort();
    const name = path.basename(directory) || projectStem;
    targets.push({
      name: name,
      packageName: projectStem,
      directory,
      files: loadSwiftFiles(sorted),
    });
  }
  return targets.sort((left, right) => left.name.localeCompare(right.name));
}

function findXcodeproj(root: string): string | null {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".xcodeproj")) continue;
    const candidate = path.join(root, name);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

function parsePackageName(contents: string): string | null {
  const packageIdx = contents.indexOf("Package(");
  if (packageIdx < 0) return null;
  const after = contents.slice(packageIdx);
  const nameIdx = after.indexOf("name:");
  if (nameIdx < 0) return null;
  const afterName = after.slice(nameIdx + "name:".length).trimStart();
  if (!afterName.startsWith('"')) return null;
  const end = afterName.indexOf('"', 1);
  if (end < 0) return null;
  const name = afterName.slice(1, end);
  return name.length > 0 ? name : null;
}

function parseTargetNames(contents: string): string[] {
  const kinds = [".executableTarget(", ".testTarget(", ".target("] as const;
  const names: string[] = [];
  const seen = new Set<string>();
  let searchFrom = 0;
  while (searchFrom < contents.length) {
    const rest = contents.slice(searchFrom);
    let bestIdx = -1;
    let bestKind: (typeof kinds)[number] | null = null;
    for (const kind of kinds) {
      const idx = rest.indexOf(kind);
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx;
        bestKind = kind;
      }
    }
    if (bestIdx < 0 || bestKind === null) break;
    const after = rest.slice(bestIdx + bestKind.length);
    const name = extractNameArgument(after);
    searchFrom += bestIdx + bestKind.length;
    if (name !== null && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function extractNameArgument(afterOpen: string): string | null {
  const nameIdx = afterOpen.indexOf("name:");
  if (nameIdx < 0 || nameIdx > 200) return null;
  const afterName = afterOpen.slice(nameIdx + "name:".length).trimStart();
  if (!afterName.startsWith('"')) return null;
  const end = afterName.indexOf('"', 1);
  if (end < 0) return null;
  const name = afterName.slice(1, end);
  return name.length > 0 ? name : null;
}

function loadSwiftFiles(paths: string[]): SwiftFile[] {
  const files: SwiftFile[] = [];
  for (const filePath of paths) {
    try {
      const source = readFileSync(filePath, "utf8");
      const parsed = parseSwiftSource(source);
      files.push({
        path: filePath,
        unreadable: false,
        imports: parsed.imports,
        symbols: parsed.symbols,
      });
    } catch {
      files.push({ path: filePath, unreadable: true, imports: [], symbols: [] });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function collectSwiftFiles(directory: string, canonicalRoot: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || isIgnoredDirectory(name, skippedDirectories)) continue;
    const child = path.join(directory, name);
    if (entry.isDirectory()) {
      collectSwiftFiles(child, canonicalRoot, out);
      continue;
    }
    if (!entry.isFile() || !name.endsWith(".swift")) continue;
    const real = safeRealpath(child);
    if (real === null || !isConfined(canonicalRoot, real)) continue;
    out.push(child);
  }
}

function collectSwiftFilesShallow(directory: string, canonicalRoot: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
    const child = path.join(directory, entry.name);
    const real = safeRealpath(child);
    if (real === null || !isConfined(canonicalRoot, real)) continue;
    out.push(child);
  }
}

function walkSwiftFiles(directory: string, canonicalRoot: string, packages: Map<string, string[]>): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || isIgnoredDirectory(name, skippedDirectories) || name.endsWith(".xcodeproj")) continue;
    const child = path.join(directory, name);
    if (entry.isDirectory()) {
      walkSwiftFiles(child, canonicalRoot, packages);
      continue;
    }
    if (!entry.isFile() || !name.endsWith(".swift")) continue;
    const real = safeRealpath(child);
    if (real === null || !isConfined(canonicalRoot, real)) continue;
    const parent = path.dirname(child);
    const list = packages.get(parent) ?? [];
    list.push(child);
    packages.set(parent, list);
  }
}

function stripSwiftComments(source: string): string {
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
    if (chars[index] === '"') {
      out += '"';
      index += 1;
      if (index + 1 < chars.length && chars[index] === '"' && chars[index + 1] === '"') {
        out += '""';
        index += 2;
        while (index < chars.length) {
          if (
            chars[index] === '"'
            && index + 2 < chars.length
            && chars[index + 1] === '"'
            && chars[index + 2] === '"'
          ) {
            out += '"""';
            index += 3;
            break;
          }
          out += chars[index];
          index += 1;
        }
        continue;
      }
      while (index < chars.length) {
        if (chars[index] === "\\") {
          out += chars[index];
          if (index + 1 < chars.length) out += chars[index + 1];
          index += 2;
          continue;
        }
        out += chars[index];
        if (chars[index] === '"') {
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

function parseImports(source: string): SwiftImport[] {
  const imports: SwiftImport[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const trimmed = lines[index]!.trim();
    let rest: string | null = null;
    if (trimmed.startsWith("import ")) rest = trimmed.slice("import ".length).trim();
    else if (trimmed.startsWith("@_exported import ")) rest = trimmed.slice("@_exported import ".length).trim();
    if (rest === null) continue;
    const { module, statement } = parseImportRest(rest, trimmed);
    if (module.length === 0) continue;
    imports.push({ line: lineNo, module, statement });
  }
  return imports;
}

function parseImportRest(rest: string, fullLine: string): { module: string; statement: string } {
  const kindPrefixes = [
    "struct ", "class ", "enum ", "protocol ", "actor ", "typealias ", "func ", "var ", "let ",
  ];
  let pathValue = rest;
  for (const prefix of kindPrefixes) {
    if (rest.startsWith(prefix)) {
      pathValue = rest.slice(prefix.length).trim();
      break;
    }
  }
  const module = pathValue.split(/[.\s]/)[0] ?? "";
  let statement = fullLine.trim().replace(/^@_exported\s+/, "");
  if (!statement.startsWith("import ")) statement = `import ${pathValue}`;
  return { module, statement };
}

function parseSymbols(source: string): SwiftSymbol[] {
  const symbols: SwiftSymbol[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const symbol = parseSymbolLine(lines[index]!.trim(), index + 1);
    if (symbol !== null) symbols.push(symbol);
  }
  return symbols;
}

function parseSymbolLine(line: string, lineNo: number): SwiftSymbol | null {
  let rest = line;
  for (;;) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith("@")) {
      const afterAt = trimmed.slice(1);
      const nameEnd = afterAt.search(/[^a-zA-Z0-9_]/);
      const afterName = (nameEnd < 0 ? "" : afterAt.slice(nameEnd)).trimStart();
      if (afterName.startsWith("(")) {
        const close = findMatchingParen(afterName);
        if (close === null) return null;
        rest = afterName.slice(close + 1).trimStart();
      } else {
        rest = afterName;
      }
      continue;
    }
    let advanced = false;
    if (trimmed.startsWith("class")) {
      const after = trimmed.slice("class".length);
      if (/^\s/.test(after)) {
        const next = after.trimStart();
        if (
          next.startsWith("func")
          || next.startsWith("var")
          || next.startsWith("let")
          || next.startsWith("subscript")
        ) {
          rest = next;
          advanced = true;
        }
      }
    }
    const modifiers = [
      "public", "private", "open", "internal", "fileprivate", "final", "static", "override",
      "mutating", "nonmutating", "async", "throws", "rethrows", "indirect", "lazy", "weak",
      "unowned", "required", "convenience", "dynamic", "optional", "infix", "prefix", "postfix",
    ];
    if (!advanced) {
      for (const modifier of modifiers) {
        if (trimmed.startsWith(modifier)) {
          const after = trimmed.slice(modifier.length);
          if (after.length === 0 || /^\s/.test(after)) {
            rest = after.trimStart();
            advanced = true;
            break;
          }
        }
      }
    }
    if (!advanced) {
      rest = trimmed;
      break;
    }
  }
  if (rest.startsWith("func ")) {
    const after = rest.slice("func ".length);
    const name = after.split(/[(\s<]/)[0]?.trim() ?? "";
    if (name.length === 0) return null;
    return { name, kind: "func", line: lineNo };
  }
  if (rest.startsWith("init")) {
    const after = rest.slice("init".length);
    if (after.startsWith("(") || after.startsWith("?") || after.startsWith("!") || after.startsWith("<")) {
      return { name: "init", kind: "init", line: lineNo };
    }
  }
  const kinds: Array<[string, SwiftSymbolKind]> = [
    ["struct ", "struct"],
    ["class ", "class"],
    ["enum ", "enum"],
    ["protocol ", "protocol"],
    ["actor ", "actor"],
    ["typealias ", "typealias"],
  ];
  for (const [keyword, kind] of kinds) {
    if (rest.startsWith(keyword)) {
      const after = rest.slice(keyword.length);
      const name = after.split(/[:{<=\s]/)[0]?.trim() ?? "";
      if (name.length === 0) return null;
      return { name, kind, line: lineNo };
    }
  }
  return null;
}

function findMatchingParen(source: string): number | null {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function swiftTargetBlockId(name: string): string {
  return `module:swift:${slug(name)}`;
}

function swiftFileBlockId(modulePath: string): string {
  return `module:swift:${slug(modulePath)}`;
}

function swiftSymbolBlockId(modulePath: string, kind: string): string {
  return `module:swift:${slug(modulePath)}:${slug(kind)}`;
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

function safeRealpath(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
