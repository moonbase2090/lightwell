import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { FactConnection, ModuleBlock } from "../model.js";

export type TypeScriptSymbolKind = "function" | "class" | "interface" | "type" | "const";

export interface TypeScriptImport {
  readonly line: number;
  readonly statement: string;
}

export interface TypeScriptSymbol {
  readonly name: string;
  readonly kind: TypeScriptSymbolKind;
  readonly line: number;
}

export interface TypeScriptModule {
  readonly name: string;
  readonly path: string;
  readonly unreadable: boolean;
  readonly imports: readonly TypeScriptImport[];
  readonly symbols: readonly TypeScriptSymbol[];
}

const skippedDirectories = new Set(["node_modules", "target", "dist"]);

type Quote = "single" | "double" | "backtick";

interface ScanState {
  quote: Quote | null;
  blockComment: boolean;
  paren: number;
  bracket: number;
}

export function discoverTypeScriptModules(repositoryPath: string): TypeScriptModule[] {
  const root = path.resolve(repositoryPath);
  const canonicalRoot = realpathSync(root);
  const files: string[] = [];
  walkTypeScriptFiles(root, canonicalRoot, new Set(), files);
  const modules = files.map((filePath) => moduleFromFile(root, filePath));
  modules.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  return modules;
}

export function parseTypeScriptSource(source: string): {
  readonly imports: TypeScriptImport[];
  readonly symbols: TypeScriptSymbol[];
} {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const imports: TypeScriptImport[] = [];
  const symbols: TypeScriptSymbol[] = [];
  const state: ScanState = { quote: null, blockComment: false, paren: 0, bracket: 0 };
  let logical = "";
  let logicalLine = 1;
  let continued = false;
  for (const [index, rawLine] of splitInclusive(text).entries()) {
    const lineNo = index + 1;
    const line = rawLine.replace(/[\n\r]+$/, "");
    if (state.blockComment) {
      scanLine(line, state);
      continue;
    }
    if (state.quote !== null) {
      scanLine(line, state);
      continue;
    }
    if (state.paren > 0 || state.bracket > 0 || continued) {
      logical += `\n${line}`;
      continued = scanLine(line, state);
      if (state.paren === 0 && state.bracket === 0 && state.quote === null && !state.blockComment && !continued) {
        classify(logical, logicalLine, imports, symbols);
        logical = "";
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (line.length !== trimmed.length) continue;
    logical = line;
    logicalLine = lineNo;
    continued = scanLine(line, state);
    if (state.paren === 0 && state.bracket === 0 && state.quote === null && !state.blockComment && !continued) {
      classify(logical, logicalLine, imports, symbols);
      logical = "";
    }
  }
  return { imports, symbols };
}

export function typescriptFactBlocks(args: {
  readonly modules: readonly TypeScriptModule[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  for (const module of args.modules) {
    const id = typescriptBlockId(module.name, null);
    const relative = toSlash(path.relative(args.rootPath, module.path));
    const fingerprint = hashFile(module.path);
    blocks.push({
      id,
      label: moduleLabel(module.name),
      type: "module",
      packageName: module.name,
      modulePath: module.name,
      declaredByPath: relative,
      cfgAttributes: module.imports.map((item) => item.statement),
      unresolved: module.unreadable,
      language: "typescript",
      parentId: args.workspaceId,
      children: [],
      sourcePath: relative,
      fingerprint,
    });
    connections.push(containsConnection(args.workspaceId, id));
    for (const symbol of module.symbols) {
      const modulePath = `${module.name}.${symbol.name}`;
      const symbolId = typescriptBlockId(modulePath, symbol.kind);
      blocks.push({
        id: symbolId,
        label: symbol.name,
        type: "module",
        packageName: module.name,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: [symbol.kind],
        unresolved: false,
        language: "typescript",
        parentId: id,
        children: [],
        sourcePath: relative,
        fingerprint,
      });
      connections.push(containsConnection(id, symbolId));
    }
  }
  return { blocks, connections };
}

function moduleFromFile(root: string, filePath: string): TypeScriptModule {
  const source = readTypeScriptSource(filePath);
  const parsed = source === null ? { imports: [], symbols: [] } : parseTypeScriptSource(source);
  return {
    name: moduleName(root, filePath),
    path: filePath,
    unreadable: source === null,
    imports: parsed.imports,
    symbols: parsed.symbols,
  };
}

function walkTypeScriptFiles(directory: string, canonicalRoot: string, seen: Set<string>, files: string[]): void {
  let canonical: string;
  try {
    canonical = realpathSync(directory);
  } catch {
    return;
  }
  if (!isConfined(canonicalRoot, canonical) || seen.has(canonical)) return;
  seen.add(canonical);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTypeScriptFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!isTypeScriptFile(child) || !isConfined(canonicalRoot, realpathSync(child))) continue;
    files.push(child);
  }
}

function isTypeScriptFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.endsWith(".d.ts")) return false;
  return /\.(ts|tsx|mts|cts)$/u.test(base);
}

function moduleName(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep);
  const file = parts.pop() ?? "";
  const stem = file.replace(/\.(tsx?|mts|cts)$/u, "");
  return [...parts, stem].filter((part) => part.length > 0).join(".");
}

function classify(line: string, lineNo: number, imports: TypeScriptImport[], symbols: TypeScriptSymbol[]): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  if (trimmed.startsWith("import ")) {
    imports.push({ line: lineNo, statement: trimmed });
    return;
  }
  const symbol = parseExportSymbol(trimmed);
  if (symbol !== null) symbols.push({ name: symbol.name, kind: symbol.kind, line: lineNo });
}

function parseExportSymbol(line: string): { readonly name: string; readonly kind: TypeScriptSymbolKind } | null {
  let rest = line.trim();
  if (!rest.startsWith("export")) return null;
  rest = rest.slice("export".length).trimStart();
  if (rest.startsWith("*") || rest.startsWith("{")) return null;
  if (rest.startsWith("default")) rest = rest.slice("default".length).trimStart();
  rest = skipKeyword(rest, "declare");
  rest = skipKeyword(rest, "async");
  return (
    parseKeywordName(rest, "function", "function")
    ?? parseKeywordName(rest, "class", "class")
    ?? parseKeywordName(rest, "interface", "interface")
    ?? parseKeywordName(rest, "type", "type")
    ?? parseKeywordName(rest, "const", "const")
  );
}

function skipKeyword(rest: string, keyword: string): string {
  return rest.startsWith(keyword) ? rest.slice(keyword.length).trimStart() : rest;
}

function parseKeywordName(
  rest: string,
  keyword: string,
  kind: TypeScriptSymbolKind,
): { readonly name: string; readonly kind: TypeScriptSymbolKind } | null {
  if (!rest.startsWith(keyword)) return null;
  const name = parseIdentifier(rest.slice(keyword.length).trimStart());
  return name === null ? null : { name, kind };
}

function parseIdentifier(source: string): string | null {
  const trimmed = source.trimStart();
  const match = /^[$A-Za-z_][$0-9A-Za-z_]*/u.exec(trimmed);
  return match === null ? null : match[0];
}

function scanLine(line: string, state: ScanState): boolean {
  let index = 0;
  while (index < line.length) {
    if (state.blockComment) {
      if (line[index] === "*" && line[index + 1] === "/") {
        index += 2;
        state.blockComment = false;
        continue;
      }
      index += 1;
      continue;
    }
    if (state.quote !== null) {
      if (state.quote === "backtick") {
        if (line[index] === "\\") {
          index += 2;
          continue;
        }
        if (line[index] === "`") state.quote = null;
        index += 1;
        continue;
      }
      if (closesQuote(line, index, state.quote)) {
        state.quote = null;
        index += 1;
        continue;
      }
      if (line[index] === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (line[index] === "/" && line[index + 1] === "/") break;
    if (line[index] === "/" && line[index + 1] === "*") {
      index += 2;
      state.blockComment = true;
      continue;
    }
    if (line[index] === "\\" && index + 1 === line.length) return true;
    const opened = opensQuote(line, index);
    if (opened !== null) {
      index += opened.length;
      state.quote = opened.quote;
      continue;
    }
    if (line[index] === "(") state.paren += 1;
    else if (line[index] === ")") state.paren -= 1;
    else if (line[index] === "[") state.bracket += 1;
    else if (line[index] === "]") state.bracket -= 1;
    index += 1;
  }
  return false;
}

function opensQuote(line: string, index: number): { readonly quote: Quote; readonly length: number } | null {
  if (line[index] === "'") return { quote: "single", length: 1 };
  if (line[index] === '"') return { quote: "double", length: 1 };
  if (line[index] === "`") return { quote: "backtick", length: 1 };
  return null;
}

function closesQuote(line: string, index: number, quote: Quote): boolean {
  const character = line[index];
  if (quote === "single" && character === "'" && !escaped(line, index)) return true;
  if (quote === "double" && character === '"' && !escaped(line, index)) return true;
  if (quote === "backtick" && character === "`" && !escaped(line, index)) return true;
  return false;
}

function escaped(line: string, index: number): boolean {
  let slashes = 0;
  let cursor = index - 1;
  while (cursor >= 0 && line[cursor] === "\\") {
    slashes += 1;
    cursor -= 1;
  }
  return slashes % 2 === 1;
}

function splitInclusive(source: string): string[] {
  const parts = source.split("\n");
  return parts.map((part, index) => (index < parts.length - 1 ? `${part}\n` : part));
}

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function typescriptBlockId(modulePath: string, kind: string | null): string {
  let id = `module:typescript:${slug(modulePath)}`;
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

function readTypeScriptSource(filePath: string): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    throw new Error(`Could not read TypeScript source ${filePath}: ${message}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
