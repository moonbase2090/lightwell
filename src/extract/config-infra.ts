import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import type { FactConnection, FactMap, ModuleBlock } from "../model.js";

export type ConfigInfraLanguage = "yaml" | "terraform" | "dockerfile";
type EntityKind = "service" | "resource" | "deployment" | "job" | "stage" | "terraform-module" | "terraform-variable" | "terraform-output" | "terraform-provider";
type Reference = { readonly kind: "entity"; readonly target: string } | { readonly kind: "file"; readonly target: string };

export interface ConfigInfraEntity {
  readonly kind: EntityKind;
  readonly name: string;
  readonly attributes: readonly string[];
  readonly references: readonly Reference[];
}

export interface ConfigInfraFile {
  readonly path: string;
  readonly language: ConfigInfraLanguage;
  readonly entities: readonly ConfigInfraEntity[];
}

export interface ConfigInfraWorkspace {
  readonly files: readonly ConfigInfraFile[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

const skippedDirectories = new Set([".git", ".terraform", "node_modules", "target", "build", "dist", "out", "vendor", "testdata", "fixtures"]);

export function discoverConfigInfra(repositoryPath: string): ConfigInfraWorkspace {
  const root = path.resolve(repositoryPath);
  const canonicalRoot = realpathSync(root);
  const paths: string[] = [];
  walk(root, canonicalRoot, new Set(), paths);
  paths.sort(compareText);
  const files = paths.map((filePath) => {
    const relative = relativePath(root, filePath);
    let source: string;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      source = "";
    }
    const language = languageFor(filePath);
    return { path: relative, language, entities: parseEntities(source, language, relative) };
  });
  return { files };
}

export function configInfraFactBlocks(args: {
  readonly workspace: ConfigInfraWorkspace;
  readonly rootPath: string;
  readonly workspaceId: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const files = args.workspace.files;
  const fileIdByPath = new Map(files.map((file) => [file.path, fileBlockId(file.path)]));
  const entityIdsByFileAndName = new Map<string, string[]>();
  const entityIdByReference = new Map<string, string[]>();
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];

  for (const file of files) {
    const fileId = fileBlockId(file.path);
    const absolutePath = path.join(args.rootPath, file.path);
    const fingerprint = hashFile(absolutePath);
    blocks.push(makeBlock({
      id: fileId,
      label: path.posix.basename(file.path),
      modulePath: file.path,
      parentId: args.workspaceId,
      declaredByPath: file.path,
      sourcePath: file.path,
      packageName: args.workspaceId,
      fingerprint,
      attributes: ["config-file"],
      language: file.language,
    }));
    connections.push(containsConnection(args.workspaceId, fileId));

    for (const entity of file.entities) {
      const id = entityBlockId(file.path, entity.kind, entity.name);
      const modulePath = `${file.path}#${entity.kind}:${entity.name}`;
      blocks.push(makeBlock({
        id,
        label: entity.name,
        modulePath,
        parentId: fileId,
        declaredByPath: file.path,
        sourcePath: file.path,
        packageName: args.workspaceId,
        fingerprint: hashText(`${fingerprint}:${entity.kind}:${entity.name}`),
        attributes: entity.attributes,
        language: file.language,
      }));
      connections.push(containsConnection(fileId, id));
      const localIds = entityIdsByFileAndName.get(`${file.path}\0${entity.name}`) ?? [];
      localIds.push(id);
      entityIdsByFileAndName.set(`${file.path}\0${entity.name}`, localIds);
      const ids = entityIdByReference.get(entity.name) ?? [];
      ids.push(id);
      entityIdByReference.set(entity.name, ids);
    }
  }

  for (const file of files) {
    for (const entity of file.entities) {
      const sourceId = entityBlockId(file.path, entity.kind, entity.name);
      for (const reference of entity.references) {
        const targets = reference.kind === "file"
          ? [fileIdByPath.get(reference.target)].filter((id): id is string => id !== undefined)
          : entityIdsByFileAndName.get(`${file.path}\0${reference.target}`)
            ?? ((entityIdByReference.get(reference.target)?.length ?? 0) === 1
              ? entityIdByReference.get(reference.target) ?? []
              : []);
        for (const target of targets) {
          if (target === sourceId) continue;
          connections.push(dependsOnConnection(sourceId, target));
        }
      }
    }
  }

  const uniqueConnections = new Map(connections.map((connection) => [connection.id, connection]));
  return { blocks, connections: [...uniqueConnections.values()].sort((left, right) => compareText(left.id, right.id)) };
}

function parseEntities(source: string, language: ConfigInfraLanguage, relative: string): ConfigInfraEntity[] {
  if (language === "yaml") return parseYamlEntities(source, relative);
  if (language === "terraform") return parseTerraformEntities(source, relative);
  return parseDockerfileEntities(source);
}

function parseYamlEntities(source: string, relative: string): ConfigInfraEntity[] {
  const entities: ConfigInfraEntity[] = [];
  let documents: JsonValue[] = [];
  try {
    documents = parseAllDocuments(source, { uniqueKeys: false }).flatMap((document) => {
      if (document.errors.length > 0) return [];
      const value: unknown = document.toJSON();
      return isJsonValue(value) ? [value] : [];
    });
  } catch {
    return entities;
  }
  for (const document of documents) {
    const root = asRecord(document);
    if (root === null) continue;
    const services = asRecord(root.services);
    if (services !== null) {
      for (const [name, serviceValue] of Object.entries(services)) {
        const service = asRecord(serviceValue);
        const references: Reference[] = [];
        for (const dependency of stringValues(service?.depends_on)) references.push({ kind: "entity", target: dependency });
        for (const volume of composeResourceNames(service?.volumes)) references.push({ kind: "entity", target: `volumes/${volume}` });
        for (const network of composeResourceNames(service?.networks)) references.push({ kind: "entity", target: `networks/${network}` });
        const build = service?.build;
        if (build !== undefined && build !== null && build !== false) {
          const buildRecord = asRecord(build);
          const context = asString(buildRecord?.context) ?? (typeof build === "string" ? build : ".");
          const dockerfile = asString(buildRecord?.dockerfile) ?? "Dockerfile";
          const targetPath = normalizeRelative(path.posix.join(path.posix.dirname(relative), context, dockerfile));
          references.push({ kind: "file", target: targetPath });
        }
        entities.push({ kind: "service", name, attributes: ["service", "compose-service"], references });
      }
    }
    for (const key of ["volumes", "networks"] as const) {
      const resources = asRecord(root[key]);
      if (resources === null) continue;
      for (const name of Object.keys(resources)) {
        entities.push({ kind: "resource", name: `${key}/${name}`, attributes: ["resource", `compose-${key}`], references: [] });
      }
    }
    const kind = asString(root.kind);
    const metadata = asRecord(root.metadata);
    const metadataName = asString(metadata?.name);
    if (kind !== null && metadataName !== null) {
      const normalizedKind = kind.toLowerCase();
      const isDeployment = ["deployment", "statefulset", "daemonset", "job", "cronjob"].includes(normalizedKind);
      entities.push({
        kind: isDeployment ? "deployment" : "resource",
        name: `${normalizedKind}/${metadataName}`,
        attributes: ["kubernetes", normalizedKind],
        references: [],
      });
    }
    const jobs = asRecord(asRecord(root.jobs));
    if (jobs !== null) {
      for (const [name, jobValue] of Object.entries(jobs)) {
        const job = asRecord(jobValue);
        const references = stringValues(job?.needs).map((target): Reference => ({ kind: "entity", target }));
        entities.push({ kind: "job", name, attributes: ["workflow-job"], references });
      }
    }
  }
  return uniqueEntities(entities);
}

function parseTerraformEntities(source: string, relative: string): ConfigInfraEntity[] {
  const entities: ConfigInfraEntity[] = [];
  let activeIndex: number | null = null;
  let depth = 0;
  let captureDependencies = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripHclComment(rawLine);
    const trimmed = line.trim();
    if (activeIndex === null) {
      const header = parseTerraformHeader(trimmed);
      if (header !== null) {
        const [blockKind, ...arguments_] = header;
        const entity = terraformEntity(blockKind, arguments_);
        if (entity !== null) {
          entities.push(entity);
          activeIndex = entities.length - 1;
          captureDependencies = false;
        }
      }
    }
    if (activeIndex !== null) {
      if (/\bdepends_on\s*=/.test(line)) captureDependencies = true;
      if (captureDependencies) {
        const active = entities[activeIndex];
        if (active !== undefined) {
          const references = hclReferences(line);
          if (references.length > 0) {
            entities[activeIndex] = {
              ...active,
              references: [...active.references, ...references.map((target): Reference => ({ kind: "entity", target }))],
            };
          }
        }
        if (line.includes("]")) captureDependencies = false;
      }
      depth += braceDelta(line);
      if (depth <= 0) activeIndex = null;
    }
  }
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    if (entity === undefined || entity.kind !== "terraform-module") continue;
    const moduleSource = moduleSourcePath(source, entity.name);
    if (moduleSource?.startsWith("./") || moduleSource?.startsWith("../")) {
      entities[index] = { ...entity, references: [...entity.references, { kind: "file", target: normalizeRelative(path.posix.join(path.posix.dirname(relative), moduleSource, "main.tf")) }] };
    }
  }
  return uniqueEntities(entities);
}

function parseTerraformHeader(line: string): string[] | null {
  const match = /^(resource|data|module|variable|output|provider)\b/.exec(line);
  if (match === null) return null;
  const rest = line.slice(match[0].length);
  const arguments_: string[] = [];
  const quoted = /"((?:\\.|[^"\\])*)"/g;
  for (const token of rest.matchAll(quoted)) arguments_.push((token[1] ?? "").replaceAll('\\"', '"'));
  return [match[1] ?? "", ...arguments_];
}

function terraformEntity(kind: string, arguments_: readonly string[]): ConfigInfraEntity | null {
  const first = arguments_[0];
  if (first === undefined) return null;
  if (kind === "resource" || kind === "data") {
    const name = arguments_[1];
    if (name === undefined) return null;
    const prefix = kind === "data" ? "data." : "";
    return { kind: "resource", name: `${prefix}${first}.${name}`, attributes: ["terraform", `terraform-${kind}`], references: [] };
  }
  const entityKind: EntityKind | null = kind === "module" ? "terraform-module"
    : kind === "variable" ? "terraform-variable"
      : kind === "output" ? "terraform-output"
        : kind === "provider" ? "terraform-provider" : null;
  return entityKind === null ? null : { kind: entityKind, name: first, attributes: ["terraform", kind], references: [] };
}

function moduleSourcePath(source: string, name: string): string | null {
  let inModule = false;
  let depth = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!inModule && new RegExp(`^\\s*module\\s+"${escapeRegExp(name)}"\\s*\\{`).test(line)) inModule = true;
    if (!inModule) continue;
    const match = /^\s*source\s*=\s*"([^"]+)"/.exec(line);
    if (match?.[1] !== undefined) return match[1];
    depth += braceDelta(line);
    if (depth <= 0) inModule = false;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDockerfileEntities(source: string): ConfigInfraEntity[] {
  const entities: ConfigInfraEntity[] = [];
  const aliases = new Set<string>();
  let stageNumber = 0;
  let activeStageIndex: number | null = null;
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*FROM\s+(\S+)(?:\s+AS\s+([\w.-]+))?/i.exec(line);
    if (match !== null) {
      stageNumber += 1;
      const image = match[1] ?? "";
      const alias = match[2];
      const name = alias ?? `stage-${stageNumber}`;
      const references: Reference[] = aliases.has(image) ? [{ kind: "entity", target: image }] : [];
      entities.push({ kind: "stage", name, attributes: ["docker-stage", "from"], references });
      activeStageIndex = entities.length - 1;
      if (alias !== undefined) aliases.add(alias);
      continue;
    }
    const copy = /^\s*COPY\s+(?:--from=)([\w.-]+)/i.exec(line);
    const target = copy?.[1];
    if (target === undefined || !aliases.has(target) || activeStageIndex === null) continue;
    const currentStage = entities[activeStageIndex];
    if (currentStage !== undefined) {
      entities[activeStageIndex] = { ...currentStage, references: [...currentStage.references, { kind: "entity", target }] };
    }
  }
  if (entities.length === 0) entities.push({ kind: "stage", name: "default", attributes: ["docker-stage"], references: [] });
  return uniqueEntities(entities);
}

function makeBlock(args: {
  readonly id: string; readonly label: string; readonly modulePath: string; readonly parentId: string;
  readonly declaredByPath: string; readonly sourcePath: string; readonly packageName: string;
  readonly fingerprint: string; readonly attributes: readonly string[]; readonly language: ConfigInfraLanguage;
}): ModuleBlock {
  return {
    id: args.id, label: args.label, type: "module", packageName: args.packageName,
    modulePath: args.modulePath, declaredByPath: args.declaredByPath, parentId: args.parentId,
    children: [], sourcePath: args.sourcePath, fingerprint: args.fingerprint,
    cfgAttributes: [...args.attributes], unresolved: false, language: args.language,
  };
}

function fileBlockId(relative: string): string {
  return `module:config-infra:${encodeId(relative)}`;
}

function entityBlockId(relative: string, kind: EntityKind, name: string): string {
  return `${fileBlockId(relative)}:${encodeId(kind)}:${encodeId(name)}`;
}

function encodeId(value: string): string {
  return Array.from(value, (character) => /^[A-Za-z0-9]$/.test(character)
    ? character
    : `_${(character.codePointAt(0) ?? 0).toString(16)}_`).join("");
}

function containsConnection(source: string, target: string): FactConnection {
  return { id: `contains:${source}->${target}`, source, target, kind: "contains" };
}

function dependsOnConnection(source: string, target: string): FactConnection {
  return { id: `depends_on:${source}->${target}`, source, target, kind: "depends_on", dependencyScope: "normal" };
}

function languageFor(filePath: string): ConfigInfraLanguage {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile" || basename.startsWith("dockerfile.")) return "dockerfile";
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".tf" || extension === ".tfvars" || extension === ".hcl" ? "terraform" : "yaml";
}

function walk(directory: string, root: string, seen: Set<string>, files: string[]): void {
  let canonical: string;
  try { canonical = realpathSync(directory); } catch { return; }
  if (!isInside(root, canonical) || seen.has(canonical)) return;
  seen.add(canonical);
  let entries: Dirent<string>[];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const name = entry.name;
    const child = path.join(directory, name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(name.toLowerCase())) walk(child, root, seen, files);
      continue;
    }
    if (!entry.isFile() || languageFor(child) === null) continue;
    if (isConfigFile(child)) files.push(child);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isConfigFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();
  return basename === "dockerfile" || basename.startsWith("dockerfile.")
    || [".yaml", ".yml", ".tf", ".tfvars", ".hcl"].includes(extension);
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function normalizeRelative(value: string): string {
  return path.posix.normalize(value).replace(/^\.\//, "");
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueEntities(entities: readonly ConfigInfraEntity[]): ConfigInfraEntity[] {
  const unique = new Map<string, ConfigInfraEntity>();
  for (const entity of entities) {
    const key = `${entity.kind}\0${entity.name}`;
    const existing = unique.get(key);
    unique.set(key, existing === undefined ? entity : {
      ...existing,
      references: [...existing.references, ...entity.references],
    });
  }
  return [...unique.values()].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.name, right.name));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function asRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function stringValues(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (value !== null && typeof value === "object") return Object.keys(value);
  return [];
}

function composeResourceNames(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value.split(":", 1)[0] ?? value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") return [entry.split(":", 1)[0] ?? entry];
      return [asString(asRecord(entry)?.source)].filter((source): source is string => source !== null);
    });
  }
  if (value !== null && typeof value === "object") return Object.keys(value);
  return [];
}

function stripHclComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && (character === "#" || line.slice(index, index + 2) === "//")) return line.slice(0, index);
  }
  return line;
}

function braceDelta(line: string): number {
  let quoted = false;
  let escaped = false;
  let delta = 0;
  for (const character of stripHclComment(line)) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{") delta += 1;
    if (character === "}") delta -= 1;
  }
  return delta;
}

function hclReferences(line: string): string[] {
  return [...line.matchAll(/\b([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)\b/g)]
    .map((match) => `${match[1]}.${match[2]}`);
}
