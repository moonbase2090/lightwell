import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FactConnection, ModuleBlock } from "../model.js";

export type PhpSymbolKind = "class" | "interface" | "trait" | "enum" | "function";

export interface PhpImport {
  readonly line: number;
  readonly qualified: string;
  readonly alias: string | null;
  readonly statement: string;
}

export interface PhpSymbol {
  readonly name: string;
  readonly kind: PhpSymbolKind;
  readonly line: number;
}

export interface PhpFile {
  readonly path: string;
  readonly unreadable: boolean;
  readonly namespace: string;
  readonly imports: readonly PhpImport[];
  readonly symbols: readonly PhpSymbol[];
}

export interface PhpPackage {
  readonly composerName: string;
  readonly importPath: string;
  readonly namespace: string;
  readonly name: string;
  readonly directory: string;
  readonly files: readonly PhpFile[];
}

const skippedDirectories = new Set(["vendor", "node_modules", "target", "dist", ".git"]);

export function discoverPhpPackages(repositoryPath: string): PhpPackage[] {
  const root = path.resolve(repositoryPath);
  const composerPath = path.join(root, "composer.json");
  if (!existsSync(composerPath)) return [];
  const project = readComposer(root, composerPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  walkPhpFiles(root, canonicalRoot, new Set(), files);
  files.sort();
  const grouped = new Map<string, PhpFile[]>();
  for (const filePath of files) {
    const phpFile = loadPhpFile(root, filePath, project);
    const list = grouped.get(phpFile.namespace) ?? [];
    list.push(phpFile);
    grouped.set(phpFile.namespace, list);
  }
  const packages = [...grouped.entries()].map(([namespace, phpFiles]) => {
    const sorted = [...phpFiles].sort((left, right) => left.path.localeCompare(right.path));
    const importPath = namespace.length === 0 ? project.name : `${project.name}/${namespace.replaceAll("\\", "/")}`;
    const directory = sorted[0] === undefined ? root : path.dirname(sorted[0].path);
    return {
      composerName: project.name,
      importPath,
      namespace,
      name: shortPhpName(namespace, project.name),
      directory,
      files: sorted,
    };
  });
  packages.sort((left, right) => left.importPath.localeCompare(right.importPath));
  return packages;
}

export function parsePhpSource(source: string): {
  readonly namespace: string;
  readonly imports: PhpImport[];
  readonly symbols: PhpSymbol[];
} {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const stripped = stripPhpCommentsAndStrings(normalized);
  return parsePhpCode(stripped);
}

export function phpFactBlocks(args: {
  readonly packages: readonly PhpPackage[];
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const symbolIds = new Map<string, string>();
  const namespaceIds = new Map<string, string>();
  for (const pkg of args.packages) {
    const packageId = phpPackageBlockId(pkg.importPath);
    if (pkg.namespace.length > 0) namespaceIds.set(pkg.namespace, packageId);
    const first = pkg.files[0];
    blocks.push({
      id: packageId,
      label: pkg.name,
      type: "module",
      packageName: pkg.composerName,
      modulePath: pkg.importPath,
      declaredByPath: toSlash(path.relative(args.rootPath, pkg.directory)),
      cfgAttributes: pkg.files.flatMap((file) => file.imports.map((item) => item.statement)),
      unresolved: pkg.files.length > 0 && pkg.files.every((file) => file.unreadable),
      language: "php",
      parentId: args.workspaceId,
      children: [],
      sourcePath: first === undefined ? null : toSlash(path.relative(args.rootPath, first.path)),
      fingerprint: contentFingerprint(pkg.files.map((file) => file.path)),
    });
    connections.push(containsConnection(args.workspaceId, packageId));
    for (const file of pkg.files) {
      const stem = path.basename(file.path, ".php");
      const modulePath = `${pkg.importPath}/${stem}`;
      const fileId = phpFileBlockId(modulePath);
      const relative = toSlash(path.relative(args.rootPath, file.path));
      const fingerprint = hashFile(file.path);
      blocks.push({
        id: fileId,
        label: stem,
        type: "module",
        packageName: pkg.composerName,
        modulePath,
        declaredByPath: relative,
        cfgAttributes: file.imports.map((item) => item.statement),
        unresolved: file.unreadable,
        language: "php",
        parentId: packageId,
        children: [],
        sourcePath: relative,
        fingerprint,
      });
      connections.push(containsConnection(packageId, fileId));
      for (const symbol of file.symbols) {
        const symbolModule = `${modulePath}.${symbol.name}`;
        const symbolId = phpSymbolBlockId(symbolModule, symbol.kind);
        const qualified = pkg.namespace.length === 0 ? symbol.name : `${pkg.namespace}\\${symbol.name}`;
        symbolIds.set(qualified, symbolId);
        blocks.push({
          id: symbolId,
          label: symbol.name,
          type: "module",
          packageName: pkg.composerName,
          modulePath: symbolModule,
          declaredByPath: relative,
          cfgAttributes: [symbol.kind],
          unresolved: false,
          language: "php",
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
    const packageId = phpPackageBlockId(pkg.importPath);
    for (const file of pkg.files) {
      if (file.unreadable) continue;
      const fileId = phpFileBlockId(`${pkg.importPath}/${path.basename(file.path, ".php")}`);
      for (const item of file.imports) {
        const symbolTarget = symbolIds.get(item.qualified);
        if (symbolTarget !== undefined && symbolTarget !== fileId) {
          pushDepends(edges, connections, fileId, symbolTarget);
        }
        const parent = item.qualified.includes("\\") ? item.qualified.slice(0, item.qualified.lastIndexOf("\\")) : "";
        const parentTarget = parent.length === 0 ? undefined : namespaceIds.get(parent);
        if (parentTarget !== undefined && parentTarget !== packageId) {
          pushDepends(edges, connections, packageId, parentTarget);
        }
        const namespaceTarget = namespaceIds.get(item.qualified);
        if (namespaceTarget !== undefined && namespaceTarget !== packageId) {
          pushDepends(edges, connections, packageId, namespaceTarget);
        }
      }
    }
  }
  return { blocks, connections };
}

interface ComposerProject {
  readonly name: string;
  readonly laravel: boolean;
  readonly psr4: readonly { readonly prefix: string; readonly dir: string }[];
}

function readComposer(root: string, composerPath: string): ComposerProject {
  const raw = readFileSync(composerPath, "utf8").replace(/^\uFEFF/, "");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`composer.json is not valid JSON at ${composerPath}`);
  }
  const record = isRecord(value) ? value : {};
  const declared = typeof record.name === "string" ? record.name.trim() : "";
  const name = declared.length > 0 ? declared : path.basename(root);
  const psr4: { prefix: string; dir: string }[] = [];
  for (const key of ["autoload", "autoload-dev"]) {
    const autoload = isRecord(record[key]) ? record[key] : undefined;
    const map = autoload !== undefined && isRecord(autoload["psr-4"]) ? autoload["psr-4"] : undefined;
    if (map === undefined) continue;
    for (const [prefix, paths] of Object.entries(map)) {
      const normalized = prefix.trim().replace(/^\\+|\\+$/g, "");
      if (typeof paths === "string") pushPsr4(psr4, normalized, paths);
      else if (Array.isArray(paths)) {
        for (const item of paths) {
          if (typeof item === "string") pushPsr4(psr4, normalized, item);
        }
      }
    }
  }
  const laravel = isFile(path.join(root, "artisan"))
    || isDir(path.join(root, "app", "Http"))
    || raw.includes("illuminate/");
  if (laravel && !psr4.some((entry) => entry.dir === "app" || entry.dir.startsWith("app/"))) {
    psr4.push({ prefix: "App", dir: "app" });
  }
  return { name, laravel, psr4 };
}

function pushPsr4(psr4: { prefix: string; dir: string }[], prefix: string, dirPath: string): void {
  const dir = dirPath.trim().replace(/^[/\\]+|[/\\]+$/g, "").replaceAll("\\", "/");
  if (dir.length === 0) return;
  psr4.push({ prefix, dir });
}

function loadPhpFile(root: string, filePath: string, project: ComposerProject): PhpFile {
  const relative = toSlash(path.relative(root, filePath));
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return {
      path: filePath,
      unreadable: true,
      namespace: inferPhpNamespace(relative, project),
      imports: [],
      symbols: [],
    };
  }
  const parsed = parsePhpSource(source);
  return {
    path: filePath,
    unreadable: false,
    namespace: parsed.namespace.length === 0 ? inferPhpNamespace(relative, project) : parsed.namespace,
    imports: parsed.imports,
    symbols: parsed.symbols,
  };
}

function inferPhpNamespace(relative: string, project: ComposerProject): string {
  let best: { readonly length: number; readonly namespace: string } | undefined;
  for (const entry of project.psr4) {
    const withSlash = `${entry.dir}/`;
    if (!relative.startsWith(withSlash)) continue;
    const rest = relative.slice(withSlash.length);
    const namespace = joinNamespace(entry.prefix, namespaceFromRelativeFile(rest));
    if (best === undefined || entry.dir.length > best.length) best = { length: entry.dir.length, namespace };
  }
  if (best !== undefined) return best.namespace;
  if (project.laravel) {
    const conventional = laravelConventionalNamespace(relative);
    if (conventional !== null) return conventional;
  }
  return "";
}

function laravelConventionalNamespace(relative: string): string | null {
  const fileDir = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
  if (fileDir === "app/Models" || fileDir.startsWith("app/Models/")) {
    const sub = fileDir.slice("app/Models".length).replace(/^\/+|\/+$/g, "");
    return joinNamespace("App\\Models", sub.replaceAll("/", "\\"));
  }
  if (fileDir === "app/Http/Controllers" || fileDir.startsWith("app/Http/Controllers/")) {
    const sub = fileDir.slice("app/Http/Controllers".length).replace(/^\/+|\/+$/g, "");
    return joinNamespace("App\\Http\\Controllers", sub.replaceAll("/", "\\"));
  }
  return null;
}

function namespaceFromRelativeFile(rest: string): string {
  const slash = rest.lastIndexOf("/");
  if (slash < 0) return "";
  return rest.slice(0, slash).replaceAll("/", "\\");
}

function joinNamespace(prefix: string, suffix: string): string {
  const left = prefix.replace(/^\\+|\\+$/g, "");
  const right = suffix.replace(/^\\+|\\+$/g, "");
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return `${left}\\${right}`;
}

function shortPhpName(namespace: string, composerName: string): string {
  if (namespace.length === 0) return composerName.split("/").at(-1) ?? composerName;
  return namespace.split("\\").at(-1) ?? namespace;
}

function walkPhpFiles(directory: string, canonicalRoot: string, seen: Set<string>, files: string[]): void {
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
      walkPhpFiles(child, canonicalRoot, seen, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".php")) continue;
    try {
      if (!isConfined(canonicalRoot, realpathSync(child))) continue;
    } catch {
      continue;
    }
    files.push(child);
  }
}

function stripPhpCommentsAndStrings(source: string): string {
  const chars = [...source];
  let index = 0;
  let out = "";
  while (index < chars.length) {
    if (chars[index] === "<" && chars[index + 1] === "<" && chars[index + 2] === "<") {
      const skipped = skipPhpHeredoc(chars, index);
      out += skipped.text;
      index = skipped.index;
      continue;
    }
    if (chars[index] === "/" && chars[index + 1] === "/") {
      while (index < chars.length && chars[index] !== "\n") index += 1;
      continue;
    }
    if (chars[index] === "#") {
      while (index < chars.length && chars[index] !== "\n") index += 1;
      continue;
    }
    if (chars[index] === "/" && chars[index + 1] === "*") {
      index += 2;
      while (index < chars.length) {
        if (chars[index] === "*" && chars[index + 1] === "/") {
          index += 2;
          break;
        }
        if (chars[index] === "\n") out += "\n";
        index += 1;
      }
      continue;
    }
    if (chars[index] === "\"" || chars[index] === "'") {
      const quote = chars[index] ?? "\"";
      out += quote;
      index += 1;
      while (index < chars.length) {
        if (chars[index] === "\\") {
          out += " ";
          index += 1;
          if (index < chars.length) {
            out += chars[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (chars[index] === quote) {
          out += quote;
          index += 1;
          break;
        }
        out += chars[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    out += chars[index];
    index += 1;
  }
  return out;
}

function skipPhpHeredoc(chars: readonly string[], start: number): { readonly text: string; readonly index: number } {
  let index = start + 3;
  if (chars[index] === "'" || chars[index] === "\"") index += 1;
  const labelStart = index;
  while (index < chars.length && /[A-Za-z0-9_]/.test(chars[index] ?? "")) index += 1;
  if (index === labelStart) return { text: "<<<", index: start + 3 };
  const label = chars.slice(labelStart, index).join("");
  if (chars[index] === "'" || chars[index] === "\"") index += 1;
  let text = "";
  while (index < chars.length && chars[index] !== "\n") index += 1;
  if (chars[index] === "\n") {
    text += "\n";
    index += 1;
  }
  while (index < chars.length) {
    const lineStart = index;
    while (index < chars.length && chars[index] !== "\n") index += 1;
    const line = chars.slice(lineStart, index).join("");
    if (chars[index] === "\n") {
      text += "\n";
      index += 1;
    }
    const closer = line.trim().replace(/;$/, "").trim();
    if (closer === label) break;
  }
  return { text, index };
}

function parsePhpCode(source: string): { readonly namespace: string; readonly imports: PhpImport[]; readonly symbols: PhpSymbol[] } {
  let namespace = "";
  const imports: PhpImport[] = [];
  const symbols: PhpSymbol[] = [];
  let braceDepth = 0;
  const typeStack: number[] = [];
  let pendingType = false;
  let pendingUse: { readonly line: number; readonly text: string } | undefined;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const startsDeclaration = parseTypeAtStart(trimmed) !== null || parseFunctionAtStart(trimmed) !== null || parseNamespaceLine(trimmed) !== null;
    if (pendingUse !== undefined && startsDeclaration) pendingUse = undefined;
    if (pendingUse !== undefined || isUseStart(trimmed)) {
      const startLine = pendingUse?.line ?? lineNo;
      const buffer = `${pendingUse?.text ?? ""}${pendingUse === undefined ? "" : " "}${trimmed}`;
      if (buffer.includes(";")) {
        if (typeStack.length === 0 && !pendingType) imports.push(...parseUseStatement(buffer, startLine));
        pendingUse = undefined;
      } else {
        pendingUse = { line: startLine, text: buffer };
      }
      continue;
    }
    if (typeStack.length === 0 && !pendingType) {
      if (namespace.length === 0) {
        const declared = parseNamespaceLine(trimmed);
        if (declared !== null) namespace = declared;
      }
      const typeSymbol = parseTypeAtStart(trimmed);
      if (typeSymbol !== null) {
        symbols.push({ name: typeSymbol.name, kind: typeSymbol.kind, line: lineNo });
        pendingType = true;
      } else {
        const functionName = parseFunctionAtStart(trimmed);
        if (functionName !== null) symbols.push({ name: functionName, kind: "function", line: lineNo });
      }
    }
    const braces = updatePhpBraces(line, braceDepth, typeStack, pendingType);
    braceDepth = braces.braceDepth;
    pendingType = braces.pendingType;
  }
  return { namespace, imports, symbols };
}

function isUseStart(line: string): boolean {
  return keywordRest(line, "use") !== null;
}

function updatePhpBraces(
  line: string,
  braceDepth: number,
  typeStack: number[],
  pendingType: boolean,
): { readonly braceDepth: number; readonly pendingType: boolean } {
  let depth = braceDepth;
  let pending = pendingType;
  for (const character of line) {
    if (character === "{") {
      depth += 1;
      if (pending) {
        typeStack.push(depth);
        pending = false;
      }
    } else if (character === "}") {
      if (typeStack.at(-1) === depth) typeStack.pop();
      depth -= 1;
    }
  }
  return { braceDepth: depth, pendingType: pending };
}

function parseNamespaceLine(line: string): string | null {
  const rest = keywordRest(line, "namespace");
  if (rest === null) return null;
  let token = rest.trim().replace(/\{$/, "").trim().replace(/;$/, "").trim().replace(/^\\+/, "");
  if (token.length === 0) return "";
  token = (token.split(/\s+/)[0] ?? "").replace(/[;{]+$/g, "").replace(/^\\+|\\+$/g, "");
  if (token.length === 0 || !namespaceOk(token)) return null;
  return token;
}

function namespaceOk(token: string): boolean {
  return token.split("\\").every((part) => {
    const ident = phpIdent(part);
    return ident !== null && ident === part;
  });
}

function parseTypeAtStart(line: string): { readonly kind: PhpSymbolKind; readonly name: string } | null {
  let rest = line.trim();
  for (;;) {
    const abstract = keywordRest(rest, "abstract");
    const finalWord = abstract ?? keywordRest(rest, "final");
    const readonly = finalWord ?? keywordRest(rest, "readonly");
    if (readonly === null) break;
    rest = readonly.trimStart();
  }
  const classRest = keywordRest(rest, "class");
  const interfaceRest = classRest === null ? keywordRest(rest, "interface") : null;
  const traitRest = classRest === null && interfaceRest === null ? keywordRest(rest, "trait") : null;
  const enumRest = classRest === null && interfaceRest === null && traitRest === null ? keywordRest(rest, "enum") : null;
  const after = classRest ?? interfaceRest ?? traitRest ?? enumRest;
  if (after === null) return null;
  const kind: PhpSymbolKind = classRest !== null ? "class" : interfaceRest !== null ? "interface" : traitRest !== null ? "trait" : "enum";
  const name = phpIdent(after.trimStart());
  if (name === null || name.length === 0) return null;
  return { kind, name };
}

function parseFunctionAtStart(line: string): string | null {
  const rest = keywordRest(line, "function");
  if (rest === null) return null;
  const name = phpIdent(rest.trimStart().replace(/^&\s*/, ""));
  return name === null || name.length === 0 ? null : name;
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

function phpIdent(value: string): string | null {
  const match = /^[_A-Za-z\p{L}][_A-Za-z0-9\p{L}\p{N}]*/u.exec(value);
  return match?.[0] ?? null;
}

function parseUseStatement(buffer: string, line: number): PhpImport[] {
  const text = buffer.trim().replace(/;$/, "").trim();
  const afterUse = keywordRest(text, "use");
  if (afterUse === null) return [];
  let rest = afterUse.trim();
  let kind = "";
  const functionRest = keywordRest(rest, "function");
  const constRest = functionRest === null ? keywordRest(rest, "const") : null;
  if (functionRest !== null) {
    kind = "function";
    rest = functionRest.trim();
  } else if (constRest !== null) {
    kind = "const";
    rest = constRest.trim();
  }
  const open = rest.indexOf("{");
  if (open >= 0) {
    const prefix = rest.slice(0, open).trim().replace(/\\+$/g, "");
    const close = rest.lastIndexOf("}");
    if (close < open) return [];
    return rest.slice(open + 1, close).split(",").flatMap((part) => {
      const trimmed = part.trim();
      if (trimmed.length === 0) return [];
      const split = splitAs(trimmed);
      if (split.name.length === 0) return [];
      const qualified = prefix.length === 0 ? split.name : `${prefix}\\${split.name}`;
      return [phpImport(kind, qualified, split.alias, line)];
    });
  }
  const split = splitAs(rest.trim().replace(/;$/, ""));
  if (split.name.length === 0) return [];
  return [phpImport(kind, split.name, split.alias, line)];
}

function splitAs(part: string): { readonly name: string; readonly alias: string | null } {
  const [name, alias] = part.split(" as ");
  return {
    name: (name ?? "").trim().replace(/^\\+/, ""),
    alias: alias === undefined ? null : alias.trim() || null,
  };
}

function phpImport(kind: string, qualified: string, alias: string | null, line: number): PhpImport {
  const name = qualified.trim().replace(/^\\+|\\+$/g, "");
  const statement = kind.length === 0
    ? alias === null ? `use ${name};` : `use ${name} as ${alias};`
    : alias === null ? `use ${kind} ${name};` : `use ${kind} ${name} as ${alias};`;
  return { line, qualified: name, alias, statement };
}

function phpPackageBlockId(importPath: string): string {
  return `module:php:${languageIdEncode(importPath)}`;
}

function phpFileBlockId(modulePath: string): string {
  return `module:php:${languageIdEncode(modulePath)}`;
}

function phpSymbolBlockId(modulePath: string, kind: string): string {
  return `module:php:${languageIdEncode(modulePath)}:${languageIdEncode(kind)}`;
}

/** Injective path/name encoding for language-pack block ids (`foo-bar` ≠ `foo_bar`, `Foo` ≠ `foo`). */
export function languageIdEncode(value: string): string {
  let out = "";
  for (const character of value) {
    if (/^[A-Za-z0-9]$/.test(character)) out += character;
    else out += `_${character.codePointAt(0)!.toString(16)}_`;
  }
  return out;
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
  const parts = filePaths.map((filePath) => hashFile(filePath)).sort();
  return hashText(parts.join("\n"));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
