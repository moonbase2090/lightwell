import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FactConnection, ModuleBlock } from "../model.js";

export type CppTargetKind = "executable" | "library" | "interface";

export type CppSymbolKind = "class" | "struct" | "function";

export interface CppInclude {
  readonly line: number;
  readonly path: string;
  readonly system: boolean;
}

export interface CppSymbol {
  readonly name: string;
  readonly kind: CppSymbolKind;
  readonly line: number;
}

export interface CppFile {
  readonly path: string;
  readonly unreadable: boolean;
  readonly includes: readonly CppInclude[];
  readonly symbols: readonly CppSymbol[];
}

export interface CppTarget {
  readonly name: string;
  readonly kind: CppTargetKind;
  readonly directory: string;
  readonly files: readonly CppFile[];
}

const skippedDirectories = new Set([
  "build",
  "node_modules",
  "target",
  "dist",
  "out",
  "DerivedData",
  "vendor",
  ".git",
]);

const cppExtensions = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);

const cmakeSourceKeywords = new Set([
  "static",
  "shared",
  "module",
  "object",
  "interface",
  "alias",
  "imported",
  "global",
  "exclude_from_all",
]);

const typeishTokens = new Set([
  "static",
  "inline",
  "constexpr",
  "virtual",
  "explicit",
  "friend",
  "void",
  "int",
  "bool",
  "auto",
  "unsigned",
  "signed",
  "long",
  "short",
  "char",
  "float",
  "double",
  "size_t",
  "ssize_t",
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "int8_t",
  "int16_t",
  "int32_t",
  "int64_t",
  "const",
  "volatile",
  "noexcept",
]);

/** Discover C/C++ targets when a root CMakeLists.txt exists. Empty when CMake is absent. */
export function discoverCppTargets(repositoryPath: string): CppTarget[] {
  const root = path.resolve(repositoryPath);
  const cmakePath = path.join(root, "CMakeLists.txt");
  if (!existsSync(cmakePath) || !statSync(cmakePath).isFile()) return [];

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return [];
  }

  const cmakeText = readFileSync(cmakePath, "utf8");
  const projectName = parseCmakeProjectName(cmakeText);
  const cmakeTargets = parseCmakeTargets(cmakeText);

  const allFiles: string[] = [];
  const seen = new Set<string>();
  walkCppFiles(root, canonicalRoot, seen, allFiles);

  const claimed = new Set<string>();
  const targets: CppTarget[] = [];

  for (const cmakeTarget of cmakeTargets) {
    const files: CppFile[] = [];
    for (const source of cmakeTarget.sources) {
      const absolute = path.resolve(root, source);
      const confined = confinedCppPath(absolute, canonicalRoot);
      if (confined !== null) {
        claimed.add(normalizeKey(absolute));
        files.push(fileFromPath(absolute));
      } else if (existsSync(absolute)) {
        // Outside opened folder — skip.
      } else {
        claimed.add(normalizeKey(absolute));
        files.push({
          path: absolute,
          unreadable: true,
          includes: [],
          symbols: [],
        });
      }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    targets.push({
      name: cmakeTarget.name,
      kind: cmakeTarget.kind,
      directory: root,
      files,
    });
  }

  const unlisted: CppFile[] = [];
  for (const filePath of allFiles) {
    const key = normalizeKey(filePath);
    if (claimed.has(key)) continue;
    claimed.add(key);
    unlisted.push(fileFromPath(filePath));
  }
  unlisted.sort((left, right) => left.path.localeCompare(right.path));

  if (targets.length === 0) {
    if (unlisted.length > 0) {
      targets.push({
        name: projectName ?? "sources",
        kind: "interface",
        directory: root,
        files: unlisted,
      });
    }
  } else if (unlisted.length > 0) {
    targets.push({
      name: "sources",
      kind: "interface",
      directory: root,
      files: unlisted,
    });
  }

  targets.sort((left, right) => left.name.localeCompare(right.name));
  return targets;
}

export function parseCppSource(source: string): {
  readonly includes: CppInclude[];
  readonly symbols: CppSymbol[];
} {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const stripped = stripCppComments(normalized);
  return {
    includes: parseIncludes(stripped),
    symbols: parseSymbols(stripped),
  };
}

export function cppIncludeStatement(include: CppInclude): string {
  return include.system ? `#include <${include.path}>` : `#include "${include.path}"`;
}

export function cppFactBlocks(args: {
  readonly targets: readonly CppTarget[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const fileIds = new Map<string, string>();

  for (const target of args.targets) {
    const targetId = cppTargetBlockId(target.name);
    const fingerprint = hashText(
      target.files
        .map((file) => {
          try {
            return hashFile(file.path);
          } catch {
            return "";
          }
        })
        .filter((value) => value.length > 0)
        .sort()
        .join("\n"),
    );
    const relativeDir = toSlash(path.relative(args.rootPath, target.directory));
    blocks.push({
      id: targetId,
      label: target.name,
      type: "module",
      packageName: target.name,
      modulePath: target.name,
      declaredByPath: relativeDir,
      cfgAttributes: [target.kind],
      unresolved: target.files.every((file) => file.unreadable),
      language: "cpp",
      parentId: args.workspaceId,
      children: [],
      sourcePath: relativeDir,
      fingerprint,
    });
    connections.push(containsConnection(args.workspaceId, targetId));

    for (const file of target.files) {
      const relative = toSlash(path.relative(args.rootPath, file.path));
      const withoutExt = stripSourceExtension(relative);
      const modulePath = `${target.name}/${withoutExt}`;
      const fileId = cppFileBlockId(modulePath);
      let fingerprintValue: string;
      try {
        fingerprintValue = hashFile(file.path);
      } catch {
        fingerprintValue = hashText(file.path);
      }
      const label = path.basename(relative, path.extname(relative)) || "file";
      blocks.push({
        id: fileId,
        label,
        type: "module",
        packageName: target.name,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: file.includes.map(cppIncludeStatement),
        unresolved: file.unreadable,
        language: "cpp",
        parentId: targetId,
        children: [],
        sourcePath: relative,
        fingerprint: fingerprintValue,
      });
      connections.push(containsConnection(targetId, fileId));
      fileIds.set(normalizeKey(file.path), fileId);

      for (const symbol of file.symbols) {
        const symbolModulePath = `${modulePath}.${symbol.name}`;
        const symbolId = cppSymbolBlockId(symbolModulePath, symbol.kind);
        blocks.push({
          id: symbolId,
          label: symbol.name,
          type: "module",
          packageName: target.name,
          modulePath: symbolModulePath,
          declaredByPath: relative,
          cfgAttributes: [symbol.kind],
          unresolved: false,
          language: "cpp",
          parentId: fileId,
          children: [],
          sourcePath: relative,
          fingerprint: fingerprintValue,
        });
        connections.push(containsConnection(fileId, symbolId));
      }
    }
  }

  appendCppIncludeConnections(args.targets, args.rootPath, fileIds, connections);
  return { blocks, connections };
}

function appendCppIncludeConnections(
  targets: readonly CppTarget[],
  rootPath: string,
  fileIds: ReadonlyMap<string, string>,
  connections: FactConnection[],
): void {
  const edges = new Set<string>();
  for (const target of targets) {
    for (const file of target.files) {
      if (file.unreadable) continue;
      const sourceId = fileIds.get(normalizeKey(file.path));
      if (sourceId === undefined) continue;
      const parent = path.dirname(file.path);
      for (const include of file.includes) {
        if (include.system) continue;
        const candidates = [
          normalizeKey(path.resolve(parent, include.path)),
          normalizeKey(path.resolve(rootPath, include.path)),
        ];
        for (const candidate of candidates) {
          const targetId = fileIds.get(candidate);
          if (targetId === undefined) continue;
          if (targetId !== sourceId) {
            const id = connectionId("depends_on", sourceId, targetId);
            if (!edges.has(id)) {
              edges.add(id);
              connections.push({
                id,
                source: sourceId,
                target: targetId,
                kind: "depends_on",
                dependencyScope: "normal",
              });
            }
          }
          break;
        }
      }
    }
  }
}

function fileFromPath(filePath: string): CppFile {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return { path: filePath, unreadable: true, includes: [], symbols: [] };
  }
  const parsed = parseCppSource(source);
  return {
    path: filePath,
    unreadable: false,
    includes: parsed.includes,
    symbols: parsed.symbols,
  };
}

function walkCppFiles(
  directory: string,
  canonicalRoot: string,
  seen: Set<string>,
  files: string[],
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || skippedDirectory(name)) continue;
    const child = path.join(directory, name);
    if (entry.isDirectory()) {
      walkCppFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!entry.isFile() || !isCppSourceFile(child)) continue;
    const canonical = confinedCppPath(child, canonicalRoot);
    if (canonical === null) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    files.push(child);
  }
}

function confinedCppPath(candidate: string, root: string): string | null {
  try {
    if (!existsSync(candidate)) return null;
    const canonical = realpathSync(candidate);
    if (!isConfined(root, canonical)) return null;
    return canonical;
  } catch {
    return null;
  }
}

function skippedDirectory(name: string): boolean {
  if (skippedDirectories.has(name)) return true;
  return name.startsWith("cmake-build-");
}

function isCppSourceFile(filePath: string): boolean {
  return cppExtensions.has(path.extname(filePath).toLowerCase());
}

function stripCmakeComments(source: string): string {
  let out = "";
  for (const line of source.split("\n")) {
    let inString = false;
    for (let index = 0; index < line.length; index += 1) {
      const ch = line[index]!;
      if (ch === '"') {
        inString = !inString;
        out += ch;
        continue;
      }
      if (!inString && ch === "#") break;
      out += ch;
    }
    out += "\n";
  }
  return out;
}

function parseCmakeProjectName(source: string): string | null {
  const cleaned = stripCmakeComments(source);
  for (const call of cmakeCalls(cleaned)) {
    if (call.name.toLowerCase() !== "project") continue;
    const name = call.args[0]?.trim() ?? "";
    if (name.length > 0) return name;
  }
  return null;
}

function parseCmakeTargets(
  source: string,
): Array<{ readonly name: string; readonly kind: CppTargetKind; readonly sources: string[] }> {
  const cleaned = stripCmakeComments(source);
  const targets: Array<{ name: string; kind: CppTargetKind; sources: string[] }> = [];
  for (const call of cmakeCalls(cleaned)) {
    const lower = call.name.toLowerCase();
    let kind: CppTargetKind;
    if (lower === "add_executable") kind = "executable";
    else if (lower === "add_library") kind = "library";
    else continue;
    const [rawName, ...rest] = call.args;
    const name = rawName?.trim() ?? "";
    if (name.length === 0) continue;
    const sources = rest
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0 && isCmakeSourceArg(arg));
    targets.push({ name, kind, sources });
  }
  return targets;
}

function isCmakeSourceArg(arg: string): boolean {
  if (cmakeSourceKeywords.has(arg.toLowerCase())) return false;
  return cppExtensions.has(path.extname(arg).toLowerCase());
}

interface CmakeCall {
  readonly name: string;
  readonly args: string[];
}

function cmakeCalls(source: string): CmakeCall[] {
  const calls: CmakeCall[] = [];
  const chars = [...source];
  let index = 0;
  while (index < chars.length) {
    const ch = chars[index]!;
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < chars.length && /[A-Za-z0-9_]/.test(chars[index]!)) index += 1;
    const name = chars.slice(start, index).join("");
    while (index < chars.length && /\s/.test(chars[index]!)) index += 1;
    if (index >= chars.length || chars[index] !== "(") continue;
    index += 1;
    let depth = 1;
    const argStart = index;
    while (index < chars.length) {
      if (chars[index] === "(") depth += 1;
      else if (chars[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    const argsRaw = chars.slice(argStart, Math.min(index, chars.length)).join("");
    if (index < chars.length && chars[index] === ")") index += 1;
    calls.push({ name, args: splitCmakeArgs(argsRaw) });
  }
  return calls;
}

function splitCmakeArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inString = false;
  for (const ch of raw) {
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && /\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) args.push(current);
  return args;
}

function stripCppComments(source: string): string {
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

function parseIncludes(source: string): CppInclude[] {
  const includes: CppInclude[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const trimmed = lines[index]!.trim();
    if (!trimmed.startsWith("#include")) continue;
    const rest = trimmed.slice("#include".length).trimStart();
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end > 1) {
        const includePath = rest.slice(1, end);
        if (includePath.length > 0) {
          includes.push({ line: lineNo, path: includePath, system: false });
        }
      }
      continue;
    }
    if (rest.startsWith("<")) {
      const end = rest.indexOf(">");
      if (end > 1) {
        const includePath = rest.slice(1, end);
        if (includePath.length > 0) {
          includes.push({ line: lineNo, path: includePath, system: true });
        }
      }
    }
  }
  return includes;
}

function parseSymbols(source: string): CppSymbol[] {
  const symbols: CppSymbol[] = [];
  let braceDepth = 0;
  let typeBodyDepth: number | null = null;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      braceDepth = updateBraceDepth(braceDepth, line);
      continue;
    }

    const insideType = typeBodyDepth !== null && braceDepth > typeBodyDepth;
    if (!insideType) {
      const className = typeNameAfter(trimmed, "class ");
      if (className !== null) {
        symbols.push({ name: className, kind: "class", line: lineNo });
        if (trimmed.includes("{")) typeBodyDepth = braceDepth;
      } else {
        const structName = typeNameAfter(trimmed, "struct ");
        if (structName !== null) {
          symbols.push({ name: structName, kind: "struct", line: lineNo });
          if (trimmed.includes("{")) typeBodyDepth = braceDepth;
        } else {
          const functionName = parseFunctionName(trimmed);
          if (functionName !== null) {
            symbols.push({ name: functionName, kind: "function", line: lineNo });
          }
        }
      }
    }

    const previous = braceDepth;
    braceDepth = updateBraceDepth(braceDepth, line);
    if (typeBodyDepth !== null && previous > typeBodyDepth && braceDepth <= typeBodyDepth) {
      typeBodyDepth = null;
    }
  }
  return symbols;
}

function updateBraceDepth(depth: number, line: string): number {
  let next = depth;
  for (const ch of line) {
    if (ch === "{") next += 1;
    else if (ch === "}") next = Math.max(0, next - 1);
  }
  return next;
}

function typeNameAfter(line: string, keyword: string): string | null {
  if (!line.startsWith(keyword)) return null;
  const rest = line.slice(keyword.length);
  const name = (rest.split(/[\s:{;]/)[0] ?? "").trim();
  if (name.length === 0 || !isIdentifier(name)) return null;
  return name;
}

function parseFunctionName(line: string): string | null {
  if (line.startsWith("class ") || line.startsWith("struct ") || line.startsWith("enum ")) {
    return null;
  }
  if (line.includes(" operator") || line.startsWith("operator")) return null;
  const open = line.indexOf("(");
  if (open < 0) return null;
  const before = line.slice(0, open).trim();
  if (before.length === 0) return null;
  const tokens = splitDeclTokens(before);
  if (tokens.length === 0) return null;
  const rawName = tokens[tokens.length - 1]!;
  const name = rawName.replace(/^\*+/, "").replace(/&+$/, "");
  if (!isIdentifier(name)) return null;
  if (tokens.length === 1) return null;
  const head = tokens.slice(0, -1);
  if (!head.some((token) => isTypeishToken(token))) return null;
  return name;
}

function splitDeclTokens(before: string): string[] {
  return before
    .split(/[\s*]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token !== "&" && token !== "&&")
    .map((token) => token.replace(/&+$/, ""))
    .filter((token) => token.length > 0);
}

function isTypeishToken(token: string): boolean {
  const cleaned = token.replace(/^\*+/, "").replace(/&+$/, "");
  return typeishTokens.has(cleaned) || isIdentifier(cleaned);
}

function isIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  if (!/[A-Za-z_]/.test(value[0]!)) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function stripSourceExtension(relative: string): string {
  const extension = path.extname(relative).toLowerCase();
  if (cppExtensions.has(extension)) {
    return toSlash(relative.slice(0, relative.length - extension.length));
  }
  return toSlash(relative);
}

function normalizeKey(filePath: string): string {
  const parts: string[] = [];
  for (const component of path.normalize(filePath).split(path.sep)) {
    if (component === "." || component.length === 0) continue;
    if (component === "..") {
      parts.pop();
      continue;
    }
    parts.push(component);
  }
  if (path.isAbsolute(filePath)) {
    return path.sep === "\\" ? parts.join(path.sep) : `/${parts.join("/")}`;
  }
  return parts.join(path.sep);
}

function cppTargetBlockId(name: string): string {
  return `module:cpp:${slug(name)}`;
}

function cppFileBlockId(modulePath: string): string {
  return `module:cpp:${slug(modulePath)}`;
}

function cppSymbolBlockId(modulePath: string, kind: string): string {
  return `module:cpp:${slug(modulePath)}:${slug(kind)}`;
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
