import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isIgnoredDirectory } from "../workspace-ignore.js";
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
  readonly language: string;
  readonly imports: readonly TypeScriptImport[];
  readonly symbols: readonly TypeScriptSymbol[];
}

type Quote = "single" | "double" | "backtick";

interface ScanState {
  quote: Quote | null;
  blockComment: boolean;
  paren: number;
  bracket: number;
  brace: number;
  angle: number;
}

function scanBalanced(state: ScanState): boolean {
  return state.paren === 0 && state.bracket === 0 && state.brace === 0 && state.angle === 0;
}

export function discoverTypeScriptModules(repositoryPath: string): TypeScriptModule[] {
  return discoverWebModules(repositoryPath);
}

export function discoverWebModules(repositoryPath: string): TypeScriptModule[] {
  const root = path.resolve(repositoryPath);
  const canonicalRoot = realpathSync(root);
  const files: string[] = [];
  walkWebFiles(root, canonicalRoot, new Set(), files);
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
  const state: ScanState = { quote: null, blockComment: false, paren: 0, bracket: 0, brace: 0, angle: 0 };
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
    if (!scanBalanced(state) || continued) {
      logical += `\n${line}`;
      continued = scanLine(line, state);
      if (scanBalanced(state) && state.quote === null && !state.blockComment && !continued) {
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
    if (scanBalanced(state) && state.quote === null && !state.blockComment && !continued) {
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
  return webFactBlocks(args);
}

export function webFactBlocks(args: {
  readonly modules: readonly TypeScriptModule[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  for (const module of args.modules) {
    const id = webBlockId(module.name, null);
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
      language: module.language,
      parentId: args.workspaceId,
      children: [],
      sourcePath: relative,
      fingerprint,
    });
    connections.push(containsConnection(args.workspaceId, id));
    for (const symbol of module.symbols) {
      const modulePath = `${module.name}.${symbol.name}`;
      const symbolId = webBlockId(modulePath, symbol.kind);
      blocks.push({
        id: symbolId,
        label: symbol.name,
        type: "module",
        packageName: module.name,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: [symbol.kind],
        unresolved: false,
        language: module.language,
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
  const language = webLanguageLabel(filePath);
  const source = readTextSource(filePath);
  const parsed =
    source === null
      ? { imports: [], symbols: [] }
      : isHtmlFile(filePath)
        ? parseHtmlSource(source)
        : isStyleFile(filePath)
          ? parseStyleSource(source)
          : isJsonConfigFile(filePath)
            ? parseJsonConfigSource(filePath, source)
            : parseTypeScriptSource(source);
  const imports = [...parsed.imports];
  if (isWebScriptFile(filePath)) {
    const hint = nextRouteHint(root, filePath);
    if (hint !== null) imports.push({ line: 1, statement: hint });
  }
  return {
    name: moduleName(root, filePath),
    path: filePath,
    unreadable: source === null,
    language,
    imports,
    symbols: parsed.symbols,
  };
}

function nextRouteHint(root: string, filePath: string): string | null {
  const base = path.basename(filePath);
  const stem = path.basename(base, path.extname(base));
  const relative = toSlash(path.relative(root, filePath));
  if (relative.startsWith("app/") || relative.startsWith("src/app/")) {
    if (
      stem === "page"
      || stem === "layout"
      || stem === "route"
      || stem === "loading"
      || stem === "error"
      || stem === "not-found"
      || stem === "template"
      || stem === "default"
    ) {
      return `next app ${stem}`;
    }
    return null;
  }
  if (relative.startsWith("pages/")) {
    return pagesRouteHint(relative.slice("pages/".length), stem);
  }
  if (relative.startsWith("src/pages/")) {
    return pagesRouteHint(relative.slice("src/pages/".length), stem);
  }
  const nestedPages = relative.indexOf("/pages/");
  if (nestedPages !== -1) {
    return pagesRouteHint(relative.slice(nestedPages + "/pages/".length), stem);
  }
  return null;
}

function pagesRouteHint(rest: string, stem: string): string | null {
  if (rest.startsWith("api/") || rest === "api") return "next pages api";
  if (stem === "_app" || stem === "_document" || stem === "_error") {
    return `next pages ${stem.slice(1)}`;
  }
  if (stem === "index") return "next pages index";
  return "next pages page";
}

function walkWebFiles(directory: string, canonicalRoot: string, seen: Set<string>, files: string[]): void {
  let canonical: string;
  try {
    canonical = realpathSync(directory);
  } catch {
    return;
  }
  if (!isConfined(canonicalRoot, canonical) || seen.has(canonical)) return;
  seen.add(canonical);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || isIgnoredDirectory(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkWebFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!isWebFile(child) || !isConfined(canonicalRoot, realpathSync(child))) continue;
    files.push(child);
  }
}

function isWebFile(filePath: string): boolean {
  return isWebScriptFile(filePath) || isHtmlFile(filePath) || isStyleFile(filePath) || isJsonConfigFile(filePath);
}

function isWebScriptFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.endsWith(".d.ts")) return false;
  if (base.startsWith("vite.config.") || base.startsWith("next.config.")) return true;
  return /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(base);
}

function isHtmlFile(filePath: string): boolean {
  return /\.(html?)$/u.test(filePath);
}

function isStyleFile(filePath: string): boolean {
  return /\.(css|scss)$/u.test(filePath);
}

function isJsonConfigFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === "package.json" || base === "tsconfig.json" || base === "jsconfig.json";
}

function webLanguageLabel(filePath: string): string {
  const base = path.basename(filePath);
  if (base === "package.json" || base === "tsconfig.json" || base === "jsconfig.json") return "json";
  if (base.startsWith("vite.config.") || base.startsWith("next.config.")) {
    return /\.(ts|mts|cts)$/u.test(base) ? "typescript" : "javascript";
  }
  if (/\.(tsx?|mts|cts)$/u.test(base)) return "typescript";
  if (/\.(jsx?|mjs|cjs)$/u.test(base)) return "javascript";
  if (/\.(html?)$/u.test(base)) return "html";
  if (/\.css$/u.test(base)) return "css";
  if (/\.scss$/u.test(base)) return "scss";
  return "javascript";
}

function moduleName(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep);
  const file = parts.pop() ?? "";
  const stem = path.basename(file, path.extname(file));
  return [...parts, stem].filter((part) => part.length > 0).join(".");
}

function classify(line: string, lineNo: number, imports: TypeScriptImport[], symbols: TypeScriptSymbol[]): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  if (trimmed.startsWith("import ")) {
    const statement = trimmed
      .split("\n")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    imports.push({ line: lineNo, statement });
    return;
  }
  const symbol = parseExportSymbol(trimmed.split("\n")[0] ?? trimmed);
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
    else if (line[index] === "{") state.brace += 1;
    else if (line[index] === "}") state.brace -= 1;
    else if (line[index] === ">") {
      if (
        line[index - 1] !== "-"
        && line[index + 1] !== "="
        && state.angle > 0
      ) {
        state.angle -= 1;
        if (state.angle > 0 && line[index + 1] === ">") {
          state.angle -= 1;
          index += 1;
        }
      }
    } else if (opensAngle(line, index)) state.angle += 1;
    index += 1;
  }
  return false;
}

function isIdentPart(character: string): boolean {
  return /[$0-9A-Za-z_]/u.test(character);
}

function opensAngle(line: string, index: number): boolean {
  if (line[index] !== "<") return false;
  if (line[index + 1] === "=") return false;
  if (line[index + 1] === "<") return false;
  if (line[index + 1] === undefined) return false;
  if (line[index + 1] === " " || line[index + 1] === "\t") return false;
  if (line[index - 1] === "<") return false;
  const next = line[index + 1];
  const prev = line[index - 1];
  if (
    next === "+"
    || next === "("
    || next === "."
    || next === "!"
    || next === "/"
    || next === "'"
    || next === '"'
    || next === "~"
    || next === "`"
    || next === "{"
    || next === "?"
    || next === "%"
    || next === "&"
    || next === "|"
    || next === "^"
  ) {
    return false;
  }
  if (next === "[") {
    let start = index;
    while (start > 0 && isIdentPart(line[start - 1] ?? "")) start -= 1;
    const first = line[start];
    if (first !== undefined && start < index) {
      const beforeValue = first >= "a" && first <= "z" || first === "_" || first === "$";
      if (beforeValue) return false;
    }
    if (prev === ")" || prev === "]") return false;
  }
  if (next !== undefined && next >= "0" && next <= "9") return false;
  if (
    next === "-"
    && line[index + 2] !== undefined
    && line[index + 2] >= "0"
    && line[index + 2] <= "9"
  ) {
    return false;
  }
  const afterMinus = line[index + 2];
  if (next === "-" && afterMinus !== undefined && isIdentPart(afterMinus)) {
    return false;
  }
  if ((prev === ")" || prev === "]") && next !== undefined && isIdentPart(next)) {
    return false;
  }
  if (next === "_" || next === "$") {
    let start = index;
    while (start > 0 && isIdentPart(line[start - 1] ?? "")) start -= 1;
    const first = line[start];
    if (first !== undefined && start < index) {
      const beforeValue = first >= "a" && first <= "z" || first === "_" || first === "$";
      if (beforeValue) return false;
    }
  }
  if (next !== undefined && isIdentPart(next)) {
    let start = index;
    while (start > 0 && isIdentPart(line[start - 1] ?? "")) start -= 1;
    const first = line[start];
    if (first !== undefined && start < index) {
      const beforeValue = first >= "a" && first <= "z" || first === "_" || first === "$";
      if (
        beforeValue
        && ((next >= "a" && next <= "z")
          || (next >= "0" && next <= "9")
          || (next >= "A" && next <= "Z")
          || next === "_"
          || next === "$")
      ) {
        return false;
      }
      if (first >= "A" && first <= "Z" && next >= "a" && next <= "z") {
        return false;
      }
    }
  }
  return true;
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

function webBlockId(modulePath: string, kind: string | null): string {
  let id = `module:web:${slug(modulePath)}`;
  if (kind !== null) id += `:${slug(kind)}`;
  return id;
}

function parseHtmlSource(source: string): { readonly imports: TypeScriptImport[]; readonly symbols: TypeScriptSymbol[] } {
  const imports: TypeScriptImport[] = [];
  const symbols: TypeScriptSymbol[] = [];
  const lower = source.toLowerCase();
  let index = 0;
  while (index < lower.length) {
    const start = lower.indexOf("<script", index);
    if (start === -1) break;
    const tagEnd = lower.indexOf(">", start);
    if (tagEnd === -1) break;
    const bodyStart = tagEnd + 1;
    const close = lower.indexOf("</script>", bodyStart);
    if (close === -1) break;
    const body = source.slice(bodyStart, close).trim();
    if (body.length > 0) {
      const parsed = parseTypeScriptSource(body);
      imports.push(...parsed.imports);
      symbols.push(...parsed.symbols);
    }
    index = close + "</script>".length;
  }
  return { imports, symbols };
}

function parseStyleSource(source: string): { readonly imports: TypeScriptImport[]; readonly symbols: TypeScriptSymbol[] } {
  const imports: TypeScriptImport[] = [];
  const symbols: TypeScriptSymbol[] = [];
  for (const [lineIndex, line] of source.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@import ") || trimmed.startsWith("@use ")) {
      imports.push({ line: lineIndex + 1, statement: trimmed });
      continue;
    }
    if (trimmed.startsWith("@keyframes ")) {
      const name = trimmed.slice("@keyframes ".length).split(/[\s{]/u)[0]?.trim();
      if (name !== undefined && name.length > 0) {
        symbols.push({ name, kind: "const", line: lineIndex + 1 });
      }
    }
  }
  return { imports, symbols };
}

function parseJsonConfigSource(
  filePath: string,
  source: string,
): { readonly imports: TypeScriptImport[]; readonly symbols: TypeScriptSymbol[] } {
  const imports: TypeScriptImport[] = [];
  const symbols: TypeScriptSymbol[] = [];
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { imports, symbols };
  }
  if (!isRecord(value)) return { imports, symbols };
  const base = path.basename(filePath);
  if (base === "package.json") {
    appendPackageJsonHints(value, imports);
  } else if (typeof value.extends === "string") {
    imports.push({ line: 1, statement: `extends "${value.extends}"` });
  }
  return { imports, symbols };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendPackageJsonHints(value: Record<string, unknown>, imports: TypeScriptImport[]): void {
  const line = 1;
  const workspaces = value.workspaces;
  if (Array.isArray(workspaces)) {
    for (const entry of workspaces) {
      if (typeof entry === "string") imports.push({ line, statement: `workspace "${entry}"` });
    }
  } else if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    for (const entry of workspaces.packages) {
      if (typeof entry === "string") imports.push({ line, statement: `workspace "${entry}"` });
    }
  }
  const frameworks = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const table = value[key];
    if (!isRecord(table)) continue;
    for (const [dependency, statement] of [
      ["react", "framework react"],
      ["next", "framework next"],
      ["vite", "framework vite"],
    ] as const) {
      if (dependency in table && !frameworks.has(dependency)) {
        frameworks.add(dependency);
        imports.push({ line, statement });
      }
    }
  }
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

function readTextSource(filePath: string): string | null {
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
