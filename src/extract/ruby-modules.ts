import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FactConnection, ModuleBlock } from "../model.js";

export type RubySymbolKind = "module" | "class" | "def";

export interface RubyImport {
  readonly line: number;
  readonly path: string;
  readonly relative: boolean;
  readonly statement: string;
}

export interface RubySymbol {
  readonly name: string;
  readonly kind: RubySymbolKind;
  readonly line: number;
}

export interface RubyFile {
  readonly path: string;
  readonly unreadable: boolean;
  readonly moduleSuffix: string;
  readonly imports: readonly RubyImport[];
  readonly symbols: readonly RubySymbol[];
}

export interface RubyPackage {
  readonly gemName: string;
  readonly importPath: string;
  readonly name: string;
  readonly directory: string;
  readonly files: readonly RubyFile[];
}

const skippedDirectories = new Set(["vendor", "node_modules", "tmp", "log", ".git", ".bundle"]);

export function discoverRubyPackages(repositoryPath: string): RubyPackage[] {
  const root = path.resolve(repositoryPath);
  const gemfilePath = path.join(root, "Gemfile");
  if (!existsSync(gemfilePath)) return [];
  const gemfile = readFileSync(gemfilePath, "utf8");
  const gemName = readGemspecName(root) ?? path.basename(root);
  const rails = railsProject(root, gemfile);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return [];
  }
  const paths: string[] = [];
  walkRubyFiles(root, canonicalRoot, new Set(), paths);
  paths.sort();
  const grouped = new Map<string, RubyFile[]>();
  for (const filePath of paths) {
    const relative = toSlash(path.relative(root, filePath));
    const unitKey = rubyUnitKey(relative, rails);
    const rubyFile = loadRubyFile(filePath, rubyFileSuffix(relative, unitKey, rails));
    const list = grouped.get(unitKey) ?? [];
    list.push(rubyFile);
    grouped.set(unitKey, list);
  }
  const packages = [...grouped.entries()].map(([unitKey, rubyFiles]) => {
    const sorted = [...rubyFiles].sort((left, right) => left.path.localeCompare(right.path));
    const importPath = unitKey.length === 0 ? gemName : `${gemName}/${unitKey}`;
    const directory = sorted[0] === undefined ? root : path.dirname(sorted[0].path);
    return {
      gemName,
      importPath,
      name: importPath.split("/").at(-1) ?? importPath,
      directory,
      files: sorted,
    };
  });
  packages.sort((left, right) => left.importPath.localeCompare(right.importPath));
  return packages;
}

export function parseRubySource(source: string): {
  readonly imports: RubyImport[];
  readonly symbols: RubySymbol[];
} {
  const views = rubyViews(source.startsWith("\uFEFF") ? source.slice(1) : source);
  const imports: RubyImport[] = [];
  const symbols: RubySymbol[] = [];
  const state: RubyScan = { depth: 0, structAt: [] };
  const codeLines = views.code.split("\n");
  const visibleLines = views.visible.split("\n");
  const lineCount = Math.max(codeLines.length, visibleLines.length);
  for (let index = 0; index < lineCount; index += 1) {
    const lineNo = index + 1;
    const codeLine = codeLines[index] ?? "";
    const visibleLine = visibleLines[index] ?? "";
    const imported = parseRequireLine(codeLine, visibleLine, lineNo);
    if (imported !== null) imports.push(imported);
    applyRubyLine(codeLine, lineNo, state, symbols);
  }
  return { imports, symbols };
}

export function resolveRubyRequire(root: string, from: string, item: RubyImport): string | null {
  if (item.relative) {
    return confinedRubyFile(root, withRbExtension(path.resolve(path.dirname(from), item.path)));
  }
  const relative = item.path.endsWith(".rb") ? item.path.replace(/^\.\//, "") : `${item.path.replace(/^\.\//, "")}.rb`;
  for (const base of [path.join(root, "lib"), root, path.join(root, "app", "models"), path.join(root, "app", "controllers")]) {
    const found = confinedRubyFile(root, path.join(base, relative));
    if (found !== null) return found;
  }
  return null;
}

export function rubyFactBlocks(args: {
  readonly packages: readonly RubyPackage[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const fileIds = new Map<string, string>();
  for (const pkg of args.packages) {
    const packageId = rubyPackageBlockId(pkg.importPath);
    const first = pkg.files[0];
    blocks.push({
      id: packageId,
      label: pkg.name,
      type: "module",
      packageName: pkg.gemName,
      modulePath: pkg.importPath,
      declaredByPath: toSlash(path.relative(args.rootPath, pkg.directory)),
      cfgAttributes: pkg.files.flatMap((file) => file.imports.map((item) => item.statement)),
      unresolved: pkg.files.length > 0 && pkg.files.every((file) => file.unreadable),
      language: "ruby",
      parentId: args.workspaceId,
      children: [],
      sourcePath: first === undefined ? null : toSlash(path.relative(args.rootPath, first.path)),
      fingerprint: contentFingerprint(pkg.files.map((file) => file.path)),
    });
    connections.push(containsConnection(args.workspaceId, packageId));
    for (const file of pkg.files) {
      const modulePath = `${pkg.importPath}/${file.moduleSuffix}`;
      const fileId = rubyFileBlockId(modulePath);
      const relative = toSlash(path.relative(args.rootPath, file.path));
      const fingerprint = hashFile(file.path);
      try {
        fileIds.set(realpathSync(file.path), fileId);
      } catch {
        fileIds.set(path.resolve(file.path), fileId);
      }
      blocks.push({
        id: fileId,
        label: file.moduleSuffix.split("/").at(-1) ?? file.moduleSuffix,
        type: "module",
        packageName: pkg.gemName,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: file.imports.map((item) => item.statement),
        unresolved: file.unreadable,
        language: "ruby",
        parentId: packageId,
        children: [],
        sourcePath: relative,
        fingerprint,
      });
      connections.push(containsConnection(packageId, fileId));
      for (const symbol of file.symbols) {
        const symbolModule = `${modulePath}.${symbol.name}`;
        const symbolId = rubySymbolBlockId(symbolModule, symbol.kind);
        blocks.push({
          id: symbolId,
          label: symbol.name,
          type: "module",
          packageName: pkg.gemName,
          modulePath: symbolModule,
          declaredByPath: relative,
          cfgAttributes: [symbol.kind],
          unresolved: false,
          language: "ruby",
          parentId: fileId,
          children: [],
          sourcePath: relative,
          fingerprint,
        });
        connections.push(containsConnection(fileId, symbolId));
      }
    }
  }
  const edges = new Set<string>();
  for (const pkg of args.packages) {
    for (const file of pkg.files) {
      if (file.unreadable) continue;
      const fileId = rubyFileBlockId(`${pkg.importPath}/${file.moduleSuffix}`);
      for (const item of file.imports) {
        const resolved = resolveRubyRequire(args.rootPath, file.path, item);
        if (resolved === null) continue;
        const target = fileIds.get(resolved);
        if (target === undefined || target === fileId) continue;
        pushDepends(edges, connections, fileId, target);
      }
    }
  }
  return { blocks, connections };
}

function loadRubyFile(filePath: string, moduleSuffix: string): RubyFile {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return { path: filePath, unreadable: true, moduleSuffix, imports: [], symbols: [] };
  }
  const parsed = parseRubySource(source);
  return { path: filePath, unreadable: false, moduleSuffix, imports: parsed.imports, symbols: parsed.symbols };
}

function railsProject(root: string, gemfile: string): boolean {
  return isFile(path.join(root, "config", "application.rb"))
    || isFile(path.join(root, "bin", "rails"))
    || gemfileDependsOnRails(gemfile);
}

function gemfileDependsOnRails(source: string): boolean {
  for (const line of source.split("\n")) {
    const code = (line.split("#")[0] ?? "").trim();
    const rest = keywordRest(code, "gem");
    if (rest === null) continue;
    const body = rest.trim().replace(/^\(\s*/, "");
    const quote = body[0];
    if (quote !== "\"" && quote !== "'") continue;
    const end = body.indexOf(quote, 1);
    if (end > 1 && body.slice(1, end) === "rails") return true;
  }
  return false;
}

function readGemspecName(root: string): string | null {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.endsWith(".gemspec")).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    const parsed = gemspecNameFromSource(text);
    if (parsed !== null) return parsed;
  }
  return null;
}

function gemspecNameFromSource(source: string): string | null {
  for (const line of source.split("\n")) {
    const code = (line.split("#")[0] ?? "").trim();
    const marker = code.indexOf(".name");
    if (marker < 0) continue;
    const rest = code.slice(marker + ".name".length).trim().replace(/^=/, "").trim();
    const quote = rest[0];
    if (quote !== "\"" && quote !== "'") continue;
    const end = rest.indexOf(quote, 1);
    if (end <= 1) continue;
    const name = rest.slice(1, end).trim();
    if (name.length > 0) return name;
  }
  return null;
}

function rubyUnitKey(relative: string, rails: boolean): string {
  if (rails && (relative.startsWith("app/models/") || relative === "app/models")) return "models";
  if (rails && (relative.startsWith("app/controllers/") || relative === "app/controllers")) return "controllers";
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

function rubyFileSuffix(relative: string, unitKey: string, rails: boolean): string {
  const noExt = relative.endsWith(".rb") ? relative.slice(0, -3) : relative;
  if (rails && unitKey === "models" && noExt.startsWith("app/models/")) return noExt.slice("app/models/".length);
  if (rails && unitKey === "controllers" && noExt.startsWith("app/controllers/")) return noExt.slice("app/controllers/".length);
  return noExt.split("/").at(-1) ?? noExt;
}

function walkRubyFiles(directory: string, canonicalRoot: string, seen: Set<string>, files: string[]): void {
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
      walkRubyFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".rb")) continue;
    try {
      if (!isConfined(canonicalRoot, realpathSync(child))) continue;
    } catch {
      continue;
    }
    files.push(child);
  }
}

function rubyViews(source: string): { readonly visible: string; readonly code: string } {
  const chars = [...source];
  let index = 0;
  let visible = "";
  let code = "";
  let lineStart = true;
  while (index < chars.length) {
    if (lineStart && chars.slice(index, index + 6).join("") === "=begin") {
      const after = chars[index + 6];
      if (after === undefined || /\s/.test(after)) {
        const skipped = skipBeginComment(chars, index);
        visible += skipped.text;
        code += skipped.text;
        index = skipped.index;
        lineStart = true;
        continue;
      }
    }
    const ch = chars[index] ?? "";
    if (ch === "#") {
      while (index < chars.length && chars[index] !== "\n") index += 1;
      lineStart = false;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      const copied = copyRubyString(chars, index);
      visible += copied.visible;
      code += copied.code;
      index = copied.index;
      lineStart = false;
      continue;
    }
    visible += ch;
    code += ch;
    index += 1;
    lineStart = ch === "\n";
  }
  return { visible, code };
}

function skipBeginComment(chars: readonly string[], start: number): { readonly text: string; readonly index: number } {
  let index = start;
  let text = "";
  while (index < chars.length && chars[index] !== "\n") index += 1;
  if (chars[index] === "\n") {
    text += "\n";
    index += 1;
  }
  while (index < chars.length) {
    const lineBegin = index;
    while (index < chars.length && chars[index] !== "\n") index += 1;
    const line = chars.slice(lineBegin, index).join("");
    if (chars[index] === "\n") {
      text += "\n";
      index += 1;
    }
    const trimmed = line.trim();
    if (trimmed === "=end" || trimmed.startsWith("=end ") || trimmed.startsWith("=end\t")) break;
  }
  return { text, index };
}

function copyRubyString(chars: readonly string[], start: number): { readonly visible: string; readonly code: string; readonly index: number } {
  const quote = chars[start] ?? "\"";
  let visible = quote;
  let code = quote;
  let index = start + 1;
  while (index < chars.length) {
    if (chars[index] === "\\") {
      visible += "\\";
      code += " ";
      index += 1;
      if (index < chars.length) {
        visible += chars[index];
        code += chars[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (chars[index] === quote) {
      visible += quote;
      code += quote;
      index += 1;
      break;
    }
    visible += chars[index];
    code += chars[index] === "\n" ? "\n" : " ";
    index += 1;
  }
  return { visible, code, index };
}

type RubyTok =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "semi" }
  | { readonly kind: "dot" }
  | { readonly kind: "colon2" }
  | { readonly kind: "lbrace" }
  | { readonly kind: "rbrace" };

interface RubyScan {
  depth: number;
  structAt: number[];
}

function tokenizeRuby(line: string): RubyTok[] {
  const chars = [...line];
  const tokens: RubyTok[] = [];
  let index = 0;
  while (index < chars.length) {
    const ch = chars[index] ?? "";
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === "#") break;
    if (ch === ";") {
      tokens.push({ kind: "semi" });
      index += 1;
      continue;
    }
    if (ch === "{") {
      tokens.push({ kind: "lbrace" });
      index += 1;
      continue;
    }
    if (ch === "}") {
      tokens.push({ kind: "rbrace" });
      index += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ kind: "dot" });
      index += 1;
      continue;
    }
    if (ch === ":" && chars[index + 1] === ":") {
      tokens.push({ kind: "colon2" });
      index += 2;
      continue;
    }
    if (ch === "_" || /[A-Za-z]/.test(ch)) {
      const start = index;
      index += 1;
      while (index < chars.length && /[A-Za-z0-9_]/.test(chars[index] ?? "")) index += 1;
      if (chars[index] === "?" || chars[index] === "!" || chars[index] === "=") index += 1;
      tokens.push({ kind: "word", text: chars.slice(start, index).join("") });
      continue;
    }
    index += 1;
  }
  return tokens;
}

function applyRubyLine(line: string, lineNo: number, state: RubyScan, symbols: RubySymbol[]): void {
  const tokens = tokenizeRuby(line);
  let index = 0;
  let atStatement = true;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token.kind === "semi") {
      atStatement = true;
      index += 1;
      continue;
    }
    if (token.kind === "lbrace") {
      state.depth += 1;
      atStatement = false;
      index += 1;
      continue;
    }
    if (token.kind === "rbrace") {
      closeRubyBlock(state);
      atStatement = false;
      index += 1;
      continue;
    }
    if (token.kind === "dot" || token.kind === "colon2") {
      atStatement = false;
      index += 1;
      continue;
    }
    if (token.kind !== "word") {
      index += 1;
      continue;
    }
    if (atStatement && (token.text === "module" || token.text === "class")) {
      const found = readConstPath(tokens, index + 1);
      if (found !== null) {
        symbols.push({ name: found.name, kind: token.text === "module" ? "module" : "class", line: lineNo });
        index = found.next;
      } else {
        index += 1;
      }
      state.depth += 1;
      state.structAt.push(state.depth);
      atStatement = false;
      continue;
    }
    if (atStatement && token.text === "def") {
      let cursor = index + 1;
      const next = tokens[cursor];
      if (next?.kind === "word" && next.text === "self") {
        cursor += 1;
        if (tokens[cursor]?.kind === "dot") cursor += 1;
      }
      if (state.structAt.length === 0) {
        const name = tokens[cursor];
        if (name?.kind === "word" && isMethodName(name.text)) {
          symbols.push({ name: name.text, kind: "def", line: lineNo });
        }
      }
      state.depth += 1;
      atStatement = false;
      index += 1;
      continue;
    }
    if (atStatement && ["if", "unless", "while", "until", "case", "begin", "for"].includes(token.text)) {
      state.depth += 1;
      atStatement = false;
      index += 1;
      continue;
    }
    if (token.text === "do") {
      state.depth += 1;
      atStatement = false;
      index += 1;
      continue;
    }
    if (token.text === "end") {
      closeRubyBlock(state);
      atStatement = false;
      index += 1;
      continue;
    }
    atStatement = false;
    index += 1;
  }
}

function closeRubyBlock(state: RubyScan): void {
  if (state.structAt.at(-1) === state.depth) state.structAt.pop();
  state.depth = Math.max(0, state.depth - 1);
}

function readConstPath(tokens: readonly RubyTok[], start: number): { readonly name: string; readonly next: number } | null {
  const first = tokens[start];
  if (first?.kind !== "word" || !isConst(first.text)) return null;
  let name = first.text;
  let cursor = start + 1;
  while (tokens[cursor]?.kind === "colon2") {
    const next = tokens[cursor + 1];
    if (next?.kind !== "word" || !isConst(next.text)) break;
    name += `::${next.text}`;
    cursor += 2;
  }
  return { name, next: cursor };
}

function isConst(name: string): boolean {
  const first = name[0];
  return first !== undefined && first >= "A" && first <= "Z";
}

function isMethodName(name: string): boolean {
  return /^[_A-Za-z][_A-Za-z0-9?!*=]*$/u.test(name);
}

function parseRequireLine(codeLine: string, visibleLine: string, line: number): RubyImport | null {
  const code = codeLine.trim();
  if (keywordRest(code, "require_relative") === null && keywordRest(code, "require") === null) return null;
  return parseRequire(visibleLine.trim(), line);
}

function parseRequire(line: string, lineNo: number): RubyImport | null {
  const relativeRest = keywordRest(line, "require_relative");
  const plainRest = relativeRest === null ? keywordRest(line, "require") : null;
  const restSource = relativeRest ?? plainRest;
  if (restSource === null) return null;
  const relative = relativeRest !== null;
  const rest = restSource.trim().replace(/^\(\s*/, "");
  const quote = rest[0];
  if (quote !== "\"" && quote !== "'") return null;
  const end = rest.indexOf(quote, 1);
  if (end <= 1) return null;
  const spec = rest.slice(1, end).trim();
  if (spec.length === 0) return null;
  const keyword = relative ? "require_relative" : "require";
  return { line: lineNo, path: spec, relative, statement: `${keyword} ${quote}${spec}${quote}` };
}

function keywordRest(line: string, keyword: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(keyword)) return null;
  const rest = trimmed.slice(keyword.length);
  if (rest.length === 0) return rest;
  const next = rest[0] ?? "";
  if (/[A-Za-z0-9_]/.test(next)) return null;
  return rest;
}

function confinedRubyFile(root: string, candidate: string): string | null {
  if (!isFile(candidate)) return null;
  try {
    const canonical = realpathSync(candidate);
    const canonicalRoot = realpathSync(root);
    return isConfined(canonicalRoot, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function withRbExtension(candidate: string): string {
  return path.extname(candidate).length === 0 ? `${candidate}.rb` : candidate;
}

function rubyPackageBlockId(importPath: string): string {
  return `module:ruby:${slug(importPath)}`;
}

function rubyFileBlockId(modulePath: string): string {
  return `module:ruby:${slug(modulePath)}`;
}

function rubySymbolBlockId(modulePath: string, kind: string): string {
  return `module:ruby:${slug(modulePath)}:${slug(kind)}`;
}

function containsConnection(source: string, target: string): FactConnection {
  return { id: connectionId("contains", source, target), source, target, kind: "contains" };
}

function pushDepends(edges: Set<string>, connections: FactConnection[], source: string, target: string): void {
  const id = connectionId("depends_on", source, target);
  if (edges.has(id)) return;
  edges.add(id);
  connections.push({ id, source, target, kind: "depends_on", dependencyScope: "normal" });
}

function connectionId(kind: "contains" | "depends_on", source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

function contentFingerprint(filePaths: readonly string[]): string {
  return hashText(filePaths.map((filePath) => hashFile(filePath)).sort().join("\n"));
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

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
