import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FactConnection, ModuleBlock } from "../model.js";

export type JvmModuleKind = "maven" | "gradle";
export type JvmLanguage = "java" | "kotlin";
export type JvmSymbolKind = "class" | "interface" | "enum" | "object" | "fun";

export interface JvmImport {
  readonly line: number;
  readonly path: string;
  readonly staticImport: boolean;
}

export interface JvmSymbol {
  readonly name: string;
  readonly kind: JvmSymbolKind;
  readonly line: number;
}

export interface JvmFile {
  readonly path: string;
  readonly language: JvmLanguage;
  readonly test: boolean;
  readonly unreadable: boolean;
  readonly imports: readonly JvmImport[];
  readonly symbols: readonly JvmSymbol[];
}

export interface JvmPackage {
  readonly name: string;
  readonly moduleName: string | null;
  readonly directory: string;
  readonly files: readonly JvmFile[];
}

export interface JvmModule {
  readonly name: string;
  readonly path: string;
  readonly kind: JvmModuleKind;
}

export interface JvmWorkspace {
  readonly modules: readonly JvmModule[];
  readonly packages: readonly JvmPackage[];
}

const skippedDirectories = new Set([
  "build",
  ".gradle",
  "target",
  "node_modules",
  "vendor",
  ".git",
  "dist",
  "out",
]);

const modifiers = new Set([
  "public", "private", "protected", "internal", "abstract", "final", "open", "sealed", "data",
  "inner", "value", "annotation", "static", "inline", "suspend", "override", "tailrec", "operator",
  "infix", "external", "expect", "actual", "companion", "native", "synchronized", "strictfp",
  "default", "transitive", "non-sealed", "const", "lateinit", "crossinline", "noinline",
]);

export function discoverJvm(repositoryPath: string): JvmWorkspace {
  const root = path.resolve(repositoryPath);
  if (!existsSync(root)) return { modules: [], packages: [] };
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return { modules: [], packages: [] };
  }
  const found = walkJvm(root, canonicalRoot);
  if (found.markers.length === 0) return { modules: [], packages: [] };
  let modules = discoverModules(root, canonicalRoot, found);
  if (modules.length === 0) {
    modules = [{
      name: singleRootName(root),
      path: root,
      kind: kindFor(root, "maven"),
    }];
  }
  modules = disambiguateNames(root, modules).sort((left, right) =>
    left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return { modules, packages: groupSources(root, modules, found.sources) };
}

export function parseJvmSource(source: string, language: JvmLanguage): {
  readonly imports: JvmImport[];
  readonly symbols: JvmSymbol[];
} {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const stripped = stripJvmComments(normalized);
  return { imports: parseImports(stripped), symbols: parseSymbols(stripped, language) };
}

export function jvmImportStatement(item: JvmImport): string {
  return item.staticImport ? `import static ${item.path};` : `import ${item.path};`;
}

export function jvmFingerprintInputs(rootPath: string, workspace: JvmWorkspace): string[] {
  const inputs: string[] = [];
  for (const module of workspace.modules) {
    inputs.push(`jvm:module:${module.name}:${jvmModuleKey(rootPath, module)}`);
    const marker = moduleMarker(module);
    if (marker !== null) {
      try {
        inputs.push(`jvm:marker:${toSlash(path.relative(rootPath, marker))}:${hashFile(marker)}`);
      } catch {
        // A missing marker still leaves the module in the map.
      }
    }
  }
  for (const pkg of workspace.packages) {
    for (const file of pkg.files) {
      try {
        inputs.push(`jvm:${toSlash(path.relative(rootPath, file.path))}:${hashFile(file.path)}`);
      } catch {
        // Unreadable paths are omitted from the workspace fingerprint, same as Go.
      }
    }
  }
  return inputs;
}

export function jvmFactBlocks(args: {
  readonly workspace: JvmWorkspace;
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];
  const moduleIds = new Map<string, string>();
  for (const module of args.workspace.modules) {
    const key = jvmModuleKey(args.rootPath, module);
    const id = `module:jvm:${slug(key)}`;
    const marker = moduleMarker(module);
    const declared = marker === null ? key : toSlash(path.relative(args.rootPath, marker));
    blocks.push({
      id,
      label: module.name,
      type: "module",
      packageName: module.name,
      modulePath: key,
      declaredByPath: declared,
      cfgAttributes: [module.kind],
      unresolved: false,
      language: "jvm",
      parentId: args.workspaceId,
      children: [],
      sourcePath: declared,
      fingerprint: moduleFingerprint(module, args.workspace.packages),
    });
    connections.push(containsConnection(args.workspaceId, id));
    moduleIds.set(module.name, id);
  }
  const packageIds = new Map<string, string>();
  for (const pkg of args.workspace.packages) {
    const moduleKey = pkg.moduleName === null
      ? ""
      : jvmModuleKey(
        args.rootPath,
        args.workspace.modules.find((module) => module.name === pkg.moduleName) ?? {
          name: pkg.moduleName,
          path: args.rootPath,
          kind: "maven",
        },
      );
    const parent = pkg.moduleName === null ? args.workspaceId : moduleIds.get(pkg.moduleName) ?? args.workspaceId;
    const id = packageBlockId(moduleKey, pkg.name);
    const label = pkg.name.length === 0 ? "(default)" : pkg.name;
    const first = pkg.files[0];
    blocks.push({
      id,
      label,
      type: "module",
      packageName: pkg.name,
      modulePath: pkg.name.length === 0 ? "(default)" : pkg.name,
      declaredByPath: toSlash(path.relative(args.rootPath, pkg.directory)),
      cfgAttributes: pkg.files.flatMap((file) => file.imports.map(jvmImportStatement)),
      unresolved: pkg.files.length > 0 && pkg.files.every((file) => file.unreadable),
      language: "jvm",
      parentId: parent,
      children: [],
      sourcePath: first === undefined ? null : toSlash(path.relative(args.rootPath, first.path)),
      fingerprint: packageFingerprint(pkg),
    });
    connections.push(containsConnection(parent, id));
    packageIds.set(`${pkg.moduleName ?? ""}\0${pkg.name}`, id);
    for (const file of pkg.files) {
      appendFile(args.rootPath, pkg, file, id, blocks, connections);
    }
  }
  const importEdges = new Set<string>();
  for (const pkg of args.workspace.packages) {
    const packageId = packageIds.get(`${pkg.moduleName ?? ""}\0${pkg.name}`);
    if (packageId === undefined) continue;
    for (const file of pkg.files) {
      const relative = toSlash(path.relative(args.rootPath, file.path));
      const fileId = fileBlockId(relative, file.test);
      for (const importItem of file.imports) {
        for (const target of importPackageMatches(importItem.path, args.workspace.packages)) {
          const targetId = packageIds.get(`${target.moduleName ?? ""}\0${target.name}`);
          if (targetId === undefined || targetId === packageId) continue;
          const id = connectionId("depends_on", fileId, targetId);
          if (importEdges.has(id)) continue;
          importEdges.add(id);
          connections.push({ id, source: fileId, target: targetId, kind: "depends_on", dependencyScope: "normal" });
        }
      }
    }
  }
  return { blocks, connections };
}

function appendFile(
  rootPath: string,
  pkg: JvmPackage,
  file: JvmFile,
  packageId: string,
  blocks: ModuleBlock[],
  connections: FactConnection[],
): void {
  const stem = path.basename(file.path, path.extname(file.path));
  const relative = toSlash(path.relative(rootPath, file.path));
  const id = fileBlockId(relative, file.test);
  const fingerprint = hashFile(file.path);
  blocks.push({
    id,
    label: stem,
    type: "module",
    packageName: pkg.name,
    modulePath: pkg.name.length === 0 ? stem : `${pkg.name}/${stem}`,
    declaredByPath: relative,
    cfgAttributes: file.imports.map(jvmImportStatement),
    unresolved: file.unreadable,
    language: file.language,
    parentId: packageId,
    children: [],
    sourcePath: relative,
    fingerprint,
  });
  connections.push(containsConnection(packageId, id));
  for (const symbol of file.symbols) {
    const symbolId = `module:jvm:${slug(relative)}:${slug(symbol.name)}:${slug(symbol.kind)}`;
    blocks.push({
      id: symbolId,
      label: symbol.name,
      type: "module",
      packageName: pkg.name,
      modulePath: pkg.name.length === 0 ? symbol.name : `${pkg.name}.${symbol.name}`,
      declaredByPath: relative,
      cfgAttributes: [symbol.kind],
      unresolved: false,
      language: file.language,
      parentId: id,
      children: [],
      sourcePath: relative,
      fingerprint,
    });
    connections.push(containsConnection(id, symbolId));
  }
}

interface Found {
  markers: string[];
  settings: string[];
  poms: string[];
  sources: string[];
}

function walkJvm(root: string, canonicalRoot: string): Found {
  const found: Found = { markers: [], settings: [], poms: [], sources: [] };
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try {
      canonical = realpathSync(directory);
    } catch {
      return;
    }
    if (!isConfined(canonicalRoot, canonical) || seen.has(canonical)) return;
    seen.add(canonical);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || skippedDirectories.has(name.toLowerCase())) continue;
      const child = path.join(directory, name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      let childCanonical: string;
      try {
        childCanonical = realpathSync(child);
      } catch {
        continue;
      }
      if (!isConfined(canonicalRoot, childCanonical)) continue;
      if (isMarkerName(name)) found.markers.push(child);
      if (name === "settings.gradle" || name === "settings.gradle.kts") found.settings.push(child);
      if (name === "pom.xml") found.poms.push(child);
      if (isSourceName(name)) found.sources.push(child);
    }
  };
  visit(root);
  return found;
}

function discoverModules(root: string, canonicalRoot: string, found: Found): JvmModule[] {
  const modules: JvmModule[] = [];
  for (const settings of [...found.settings].sort()) {
    let text: string;
    try {
      text = readFileSync(settings, "utf8");
    } catch {
      continue;
    }
    const base = path.dirname(settings);
    for (const spec of gradleIncludes(text)) {
      pushModule(modules, base, spec, "gradle", canonicalRoot);
    }
  }
  for (const pom of [...found.poms].sort()) {
    let text: string;
    try {
      text = readFileSync(pom, "utf8");
    } catch {
      continue;
    }
    const base = path.dirname(pom);
    for (const spec of mavenModulePaths(text)) {
      pushModule(modules, base, spec, "maven", canonicalRoot);
    }
  }
  return modules.map((module) => ({ ...module, kind: kindFor(module.path, module.kind) }));
}

function pushModule(
  modules: JvmModule[],
  base: string,
  spec: string,
  kind: JvmModuleKind,
  canonicalRoot: string,
): void {
  const relative = includeToRelative(spec);
  if (relative === null) return;
  const joined = safeJoin(base, relative);
  if (joined === null) return;
  if (existsSync(joined)) {
    try {
      if (!isConfined(canonicalRoot, realpathSync(joined))) return;
    } catch {
      return;
    }
  }
  if (modules.some((module) => sameDir(module.path, joined))) return;
  modules.push({ name: "", path: joined, kind });
}

function groupSources(root: string, modules: readonly JvmModule[], sources: readonly string[]): JvmPackage[] {
  const files = sources.map(fileFromPath).sort((left, right) => left.path.localeCompare(right.path));
  const grouped = new Map<string, JvmFile[]>();
  const directories = new Map<string, string>();
  for (const file of files) {
    const moduleName = moduleForFile(file.path, modules)?.name ?? null;
    const packageName = file.unreadable ? "" : packageNameFrom(file.path) ?? "";
    const key = `${moduleName ?? ""}\0${packageName}`;
    if (!directories.has(key)) directories.set(key, path.dirname(file.path));
    const list = grouped.get(key) ?? [];
    list.push(file);
    grouped.set(key, list);
  }
  const packages: JvmPackage[] = [];
  for (const [key, packageFiles] of grouped) {
    const split = key.indexOf("\0");
    const moduleKey = key.slice(0, split);
    packages.push({
      name: key.slice(split + 1),
      moduleName: moduleKey.length === 0 ? null : moduleKey,
      directory: directories.get(key) ?? root,
      files: packageFiles,
    });
  }
  packages.sort((left, right) =>
    (left.moduleName ?? "").localeCompare(right.moduleName ?? "")
    || left.name.localeCompare(right.name)
    || left.directory.localeCompare(right.directory));
  return packages;
}

function fileFromPath(filePath: string): JvmFile {
  const language = languageFor(filePath);
  const test = isTestFile(filePath);
  const read = readUtf8(filePath);
  if (read.text === null) {
    return { path: filePath, language, test, unreadable: true, imports: [], symbols: [] };
  }
  const parsed = parseJvmSource(read.text, language);
  return { path: filePath, language, test, unreadable: false, imports: parsed.imports, symbols: parsed.symbols };
}

function readUtf8(filePath: string): { readonly text: string | null } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return { text: null };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { text: null };
  }
}

function packageNameFrom(filePath: string): string | null {
  const read = readUtf8(filePath);
  if (read.text === null) return null;
  const stripped = stripJvmComments(read.text.startsWith("\uFEFF") ? read.text.slice(1) : read.text);
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("package ")) continue;
    const name = trimmed.slice("package ".length).trim().replace(/;$/, "").split(/\s+/)[0];
    return name === undefined || name.length === 0 ? null : name;
  }
  return null;
}

function moduleForFile(filePath: string, modules: readonly JvmModule[]): JvmModule | null {
  let best: JvmModule | null = null;
  let bestLength = -1;
  for (const module of modules) {
    if (!isWithin(module.path, filePath)) continue;
    if (module.path.length > bestLength) {
      best = module;
      bestLength = module.path.length;
    }
  }
  return best;
}

function singleRootName(root: string): string {
  return readSettingsName(root) ?? readMavenArtifactId(root) ?? path.basename(root);
}

function readSettingsName(root: string): string | null {
  for (const name of ["settings.gradle.kts", "settings.gradle"]) {
    const filePath = path.join(root, name);
    if (!isFile(filePath)) continue;
    try {
      const project = gradleProjectName(readFileSync(filePath, "utf8"));
      if (project !== null) return project;
    } catch {
      continue;
    }
  }
  return null;
}

function readMavenArtifactId(root: string): string | null {
  const filePath = path.join(root, "pom.xml");
  if (!isFile(filePath)) return null;
  try {
    return mavenArtifactId(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function disambiguateNames(root: string, modules: readonly JvmModule[]): JvmModule[] {
  const leaves = modules.map((module) => leafName(root, module.path));
  const counts = new Map<string, number>();
  for (const leaf of leaves) counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
  return modules.map((module, index) => {
    if (module.name.length > 0) return module;
    const leaf = leaves[index] ?? path.basename(module.path);
    if ((counts.get(leaf) ?? 0) > 1) {
      const relative = toSlash(path.relative(root, module.path));
      return { ...module, name: relative.length === 0 ? leaf : relative };
    }
    return { ...module, name: leaf };
  });
}

function leafName(root: string, modulePath: string): string {
  const base = path.basename(modulePath);
  return base.length === 0 ? toSlash(path.relative(root, modulePath)) : base;
}

function kindFor(dir: string, fallback: JvmModuleKind): JvmModuleKind {
  if (isFile(path.join(dir, "build.gradle")) || isFile(path.join(dir, "build.gradle.kts"))) return "gradle";
  if (isFile(path.join(dir, "pom.xml"))) return "maven";
  return fallback;
}

function moduleMarker(module: JvmModule): string | null {
  const names = module.kind === "gradle"
    ? ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"]
    : ["pom.xml"];
  return names.map((name) => path.join(module.path, name)).find((candidate) => isFile(candidate)) ?? null;
}

function jvmModuleKey(root: string, module: JvmModule): string {
  const relative = toSlash(path.relative(root, module.path));
  return relative.length === 0 || relative === "." ? module.name : relative;
}

function packageBlockId(moduleKey: string, packageName: string): string {
  const packageSlug = packageName.length === 0 ? "default" : slug(packageName);
  return moduleKey.length === 0 ? `module:jvm:pkg:${packageSlug}` : `module:jvm:${slug(moduleKey)}:${packageSlug}`;
}

function fileBlockId(relative: string, test: boolean): string {
  const id = `module:jvm:${slug(relative)}`;
  return test ? `${id}:test` : id;
}

function importPackageMatches(importPath: string, packages: readonly JvmPackage[]): JvmPackage[] {
  const normalized = normalizeImportPath(importPath);
  let best = 0;
  let matched: JvmPackage[] = [];
  for (const pkg of packages) {
    if (pkg.name.length === 0 || !importMatchesPackage(normalized, pkg.name)) continue;
    if (pkg.name.length > best) {
      best = pkg.name.length;
      matched = [pkg];
    } else if (pkg.name.length === best) {
      matched = [...matched, pkg];
    }
  }
  return matched;
}

function normalizeImportPath(importPath: string): string {
  return importPath.trim().replace(/;$/, "").replace(/\.\*$/, "").replace(/\.$/, "");
}

function importMatchesPackage(importPath: string, packageName: string): boolean {
  return importPath === packageName || importPath.startsWith(`${packageName}.`);
}

function gradleIncludes(source: string): string[] {
  const stripped = stripJvmComments(source);
  const includes: string[] = [];
  let rest = stripped;
  while (rest.length > 0) {
    const index = findWord(rest, "include");
    if (index === null) break;
    const afterWord = rest.slice(index + "include".length);
    const after = afterWord.trimStart();
    if (after.startsWith("(")) {
      const consumed = skipParens(after);
      includes.push(...quotedStrings(after.slice(0, consumed)));
      const ws = afterWord.length - after.length;
      rest = rest.slice(index + "include".length + ws + consumed);
      continue;
    }
    const line = after.split("\n")[0] ?? "";
    includes.push(...quotedStrings(line));
    const newline = rest.slice(index).indexOf("\n");
    if (newline < 0) break;
    rest = rest.slice(index + newline + 1);
  }
  return includes.flatMap((spec) => {
    const relative = includeToRelative(spec);
    return relative === null ? [] : [relative];
  });
}

function gradleProjectName(source: string): string | null {
  const stripped = stripJvmComments(source);
  let rest = stripped;
  while (rest.length > 0) {
    const index = rest.indexOf("rootProject");
    if (index < 0) return null;
    const beforeOk = index === 0 || !isIdentChar(rest[index - 1] ?? "");
    const after = rest.slice(index + "rootProject".length).trimStart();
    if (beforeOk && after.startsWith(".name")) {
      const value = after.slice(".name".length).trimStart();
      if (value.startsWith("=")) {
        const name = quotedStrings(value.slice(1).split("\n")[0] ?? "")[0];
        if (name !== undefined && name.length > 0) return name;
      }
    }
    rest = rest.slice(index + "rootProject".length);
  }
  return null;
}

function mavenModulePaths(source: string): string[] {
  const stripped = stripXmlComments(source);
  const modules: string[] = [];
  let rest = stripped;
  while (rest.includes("<modules>")) {
    const start = rest.indexOf("<modules>");
    const after = rest.slice(start + "<modules>".length);
    const end = after.indexOf("</modules>");
    const body = end < 0 ? after : after.slice(0, end);
    let inner = body;
    while (inner.includes("<module>")) {
      const tag = inner.indexOf("<module>");
      const content = inner.slice(tag + "<module>".length);
      const close = content.indexOf("</module>");
      const name = (close < 0 ? content : content.slice(0, close)).trim();
      if (name.length > 0 && !name.includes("<")) modules.push(name);
      inner = close < 0 ? "" : content.slice(close);
    }
    rest = end < 0 ? "" : after.slice(end);
  }
  return modules;
}

function mavenArtifactId(source: string): string | null {
  let text = stripXmlComments(source);
  for (const tag of ["parent", "dependencies", "dependencyManagement", "build", "plugins"]) {
    text = removeXmlElement(text, tag);
  }
  const start = text.indexOf("<artifactId>");
  if (start < 0) return null;
  const rest = text.slice(start + "<artifactId>".length);
  const end = rest.indexOf("</artifactId>");
  if (end < 0) return null;
  const name = rest.slice(0, end).trim();
  return name.length === 0 || name.includes("<") ? null : name;
}

function removeXmlElement(source: string, tag: string): string {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = "";
  let rest = source;
  while (rest.includes(open)) {
    const start = rest.indexOf(open);
    const after = rest.slice(start + open.length);
    const boundaryChar = after[0] ?? "";
    const boundary = boundaryChar.length === 0 || boundaryChar === ">" || /\s/.test(boundaryChar) || boundaryChar === "/";
    if (!boundary) {
      out += rest.slice(0, start + open.length);
      rest = rest.slice(start + open.length);
      continue;
    }
    out += rest.slice(0, start);
    const end = rest.slice(start).indexOf(close);
    if (end < 0) return out;
    rest = rest.slice(start + end + close.length);
  }
  return out + rest;
}

function stripXmlComments(source: string): string {
  let out = "";
  let rest = source;
  while (rest.includes("<!--")) {
    const start = rest.indexOf("<!--");
    out += rest.slice(0, start);
    const end = rest.slice(start + 4).indexOf("-->");
    if (end < 0) return out;
    rest = rest.slice(start + 4 + end + 3);
  }
  return out + rest;
}

function parseImports(source: string): JvmImport[] {
  const imports: JvmImport[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim().replace(/;$/, "").trim();
    if (!trimmed.startsWith("import ")) continue;
    let rest = trimmed.slice("import ".length).trim();
    if (rest.length === 0) continue;
    let staticImport = false;
    if (rest.startsWith("static ")) {
      staticImport = true;
      rest = rest.slice("static ".length).trim();
    }
    rest = (rest.split(" as ")[0] ?? rest).trim();
    const importPath = (rest.split(/\s+/)[0] ?? "").replace(/;$/, "");
    if (importPath.length === 0 || !/^[\w.*]+$/.test(importPath)) continue;
    imports.push({ line: index + 1, path: importPath, staticImport });
  }
  return imports;
}

function parseSymbols(source: string, language: JvmLanguage): JvmSymbol[] {
  const symbols: JvmSymbol[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const symbol = parseSymbolLine(lines[index] ?? "", index + 1, language);
    if (symbol !== null) symbols.push(symbol);
  }
  return symbols;
}

function parseSymbolLine(line: string, lineNo: number, language: JvmLanguage): JvmSymbol | null {
  const head = declarationHead(line);
  const take = (prefix: string, kind: JvmSymbolKind): JvmSymbol | null => {
    if (!head.startsWith(prefix)) return null;
    const name = ident(head.slice(prefix.length));
    return name === null ? null : { name, kind, line: lineNo };
  };
  return take("enum class ", "enum")
    ?? take("enum ", "enum")
    ?? take("fun interface ", "interface")
    ?? take("interface ", "interface")
    ?? take("class ", "class")
    ?? (language === "kotlin" ? take("object ", "object") ?? takeFun(head, lineNo) : null);
}

function takeFun(head: string, lineNo: number): JvmSymbol | null {
  if (!head.startsWith("fun ")) return null;
  const name = funName(head.slice("fun ".length));
  return name === null ? null : { name, kind: "fun", line: lineNo };
}

function declarationHead(line: string): string {
  let current = line.trim();
  for (;;) {
    const next = stripLeading(current);
    if (next.length === current.length) return current;
    current = next.trimStart();
  }
}

function stripLeading(line: string): string {
  const annotation = stripAnnotation(line);
  if (annotation !== null) return annotation;
  for (const modifier of modifiers) {
    if (!line.startsWith(modifier)) continue;
    const rest = line.slice(modifier.length);
    if (rest.length === 0 || /^\s/.test(rest)) return rest;
  }
  return line;
}

function stripAnnotation(line: string): string | null {
  if (!line.startsWith("@")) return null;
  let index = 1;
  while (index < line.length) {
    const character = line[index] ?? "";
    if (/[\w.:]/.test(character)) index += 1;
    else break;
  }
  const rest = line.slice(index);
  return rest.startsWith("(") ? rest.slice(skipParens(rest)) : rest;
}

function ident(source: string): string | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(source);
  return match?.[1] ?? null;
}

function funName(source: string): string | null {
  let rest = source.trimStart();
  if (rest.startsWith("<")) {
    const skipped = skipGeneric(rest);
    if (skipped === null) return null;
    rest = skipped.trimStart();
  }
  const head = rest.split("(")[0]?.trim() ?? "";
  if (head.length === 0) return null;
  const segment = head.replace(/\?$/, "").split(".").at(-1)?.trim() ?? "";
  return ident(segment);
}

function skipGeneric(source: string): string | null {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "<") depth += 1;
    else if (character === ">") {
      depth -= 1;
      if (depth === 0) return source.slice(index + 1);
    }
  }
  return null;
}

function skipParens(source: string): number {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function findWord(source: string, word: string): number | null {
  let start = 0;
  while (start < source.length) {
    const relative = source.slice(start).indexOf(word);
    if (relative < 0) return null;
    const index = start + relative;
    const before = index === 0 ? "" : source[index - 1] ?? "";
    const after = source[index + word.length] ?? "";
    if (!isIdentChar(before) && !isIdentChar(after)) return index;
    start = index + word.length;
  }
  return null;
}

function isIdentChar(character: string): boolean {
  return character.length > 0 && /[A-Za-z0-9_]/.test(character);
}

function quotedStrings(source: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < source.length) {
    const quote = source[index];
    if (quote !== "\"" && quote !== "'") {
      index += 1;
      continue;
    }
    index += 1;
    let current = "";
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\" && index + 1 < source.length) {
        current += source[index + 1];
        index += 2;
        continue;
      }
      current += source[index];
      index += 1;
    }
    if (index < source.length) index += 1;
    if (current.length > 0) values.push(current);
  }
  return values;
}

function stripJvmComments(source: string): string {
  const chars = [...source];
  let index = 0;
  let out = "";
  while (index < chars.length) {
    const current = chars[index] ?? "";
    const next = chars[index + 1] ?? "";
    if (current === "/" && next === "/") {
      while (index < chars.length && chars[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
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
    if (current === "\"" && chars[index + 1] === "\"" && chars[index + 2] === "\"") {
      out += "\"\"\"";
      index += 3;
      while (index < chars.length) {
        if (chars[index] === "\"" && chars[index + 1] === "\"" && chars[index + 2] === "\"") {
          out += "\"\"\"";
          index += 3;
          break;
        }
        out += chars[index] ?? "";
        index += 1;
      }
      continue;
    }
    if (current === "\"" || current === "'") {
      const quote = current;
      out += quote;
      index += 1;
      while (index < chars.length) {
        if (chars[index] === "\\" && quote === "\"") {
          out += chars[index] ?? "";
          if (index + 1 < chars.length) out += chars[index + 1] ?? "";
          index += 2;
          continue;
        }
        out += chars[index] ?? "";
        if (chars[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += current;
    index += 1;
  }
  return out;
}

function includeToRelative(spec: string): string | null {
  const trimmed = spec.trim().replace(/^:+/, "");
  if (trimmed.length === 0) return null;
  const relative = trimmed.replaceAll(":", "/");
  if (relative.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  return relative;
}

function safeJoin(base: string, relative: string): string | null {
  if (relative.length === 0) return null;
  const parts = relative.split(/[/\\]/).filter((segment) => segment.length > 0 && segment !== ".");
  if (parts.some((segment) => segment === "..")) return null;
  return path.join(base, ...parts);
}

function isMarkerName(name: string): boolean {
  return name === "pom.xml"
    || name === "build.gradle"
    || name === "build.gradle.kts"
    || name === "settings.gradle"
    || name === "settings.gradle.kts";
}

function isSourceName(name: string): boolean {
  if (isMarkerName(name)) return false;
  const extension = name.split(".").at(-1)?.toLowerCase();
  return extension === "java" || extension === "kt" || extension === "kts";
}

function languageFor(filePath: string): JvmLanguage {
  return path.extname(filePath).toLowerCase() === ".java" ? "java" : "kotlin";
}

function isTestFile(filePath: string): boolean {
  const parts = filePath.split(/[/\\]/);
  if (parts.some((part, index) => part === "src" && parts[index + 1] === "test")) return true;
  const name = path.basename(filePath);
  return name.endsWith("Test.java") || name.endsWith("Test.kt") || name.endsWith("Test.kts");
}

function sameDir(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function moduleFingerprint(module: JvmModule, packages: readonly JvmPackage[]): string {
  const parts: string[] = [];
  const marker = moduleMarker(module);
  if (marker !== null) {
    try {
      parts.push(hashFile(marker));
    } catch {
      // A missing marker does not discard the module.
    }
  }
  for (const pkg of packages) {
    if (pkg.moduleName !== module.name) continue;
    for (const file of pkg.files) parts.push(hashFile(file.path));
  }
  parts.sort();
  return hashText(parts.join("\n"));
}

function packageFingerprint(pkg: JvmPackage): string {
  return hashText(pkg.files.map((file) => hashFile(file.path)).sort().join("\n"));
}

function containsConnection(source: string, target: string): FactConnection {
  return { id: connectionId("contains", source, target), source, target, kind: "contains" };
}

function connectionId(kind: "contains" | "depends_on", source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

function slug(value: string): string {
  let out = "";
  for (const character of value) {
    if (/^[\p{L}\p{N}]$/u.test(character)) out += character.toLowerCase();
    else if (out.length > 0 && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/g, "");
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toSlash(value: string): string {
  return value.split(path.sep).join("/");
}
