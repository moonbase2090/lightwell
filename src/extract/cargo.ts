import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AppBlock,
  CargoFeatureBlock,
  CrateBlock,
  FactBlock,
  FactConnection,
  FactGroup,
  FactMap,
  ModuleBlock,
  WorkspaceBlock,
} from "../model.js";
import { discoverCppTargets, cppFactBlocks } from "./cpp-modules.js";
import { discoverDotnet, dotnetFactBlocks } from "./dotnet-modules.js";
import { discoverGoPackages, goFactBlocks } from "./go-modules.js";
import { discoverPhpPackages, phpFactBlocks } from "./php-modules.js";
import { discoverJvm, jvmFactBlocks, jvmFingerprintInputs } from "./jvm-modules.js";
import { configInfraFactBlocks, discoverConfigInfra } from "./config-infra.js";
import { discoverPythonModules, discoverPythonProject, pythonFactBlocks } from "./python-modules.js";
import { discoverRubyPackages, rubyFactBlocks } from "./ruby-modules.js";
import { discoverSwiftTargets, swiftFactBlocks } from "./swift-modules.js";
import { moduleDirectoryForSource, readModuleSource, resolveModuleSource, rustModuleDeclarations } from "./rust-modules.js";
import { discoverWebModules, webFactBlocks } from "./web-modules.js";

interface CargoTarget {
  readonly name: string;
  readonly kind: readonly string[];
  readonly sourcePath: string;
}

interface CargoDependency {
  readonly name: string;
  readonly path: string | null;
  readonly kind: "normal" | "build" | "dev";
}

interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly description: string | null;
  readonly targets: readonly CargoTarget[];
  readonly features: readonly string[];
  readonly dependencies: readonly CargoDependency[];
}

interface CargoMetadata {
  readonly workspaceRoot: string;
  readonly workspaceMemberIds: readonly string[];
  readonly packages: readonly CargoPackage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`cargo metadata field ${label} must be a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`cargo metadata field ${label} must be a string array`);
  }
  return value;
}

function parseMetadata(value: unknown): CargoMetadata {
  if (!isRecord(value)) throw new Error("cargo metadata returned a non-object value");
  const workspaceRoot = requiredString(value.workspace_root, "workspace_root");
  const workspaceMemberIds = stringArray(value.workspace_members, "workspace_members");
  if (!Array.isArray(value.packages)) throw new Error("cargo metadata field packages must be an array");

  const packages = value.packages.map((item, packageIndex): CargoPackage => {
    if (!isRecord(item)) throw new Error(`cargo metadata package ${packageIndex} must be an object`);
    if (!Array.isArray(item.targets)) throw new Error(`cargo metadata package ${packageIndex} has no targets array`);
    if (!isRecord(item.features)) throw new Error(`cargo metadata package ${packageIndex} has no features object`);
    if (!Array.isArray(item.dependencies)) throw new Error(`cargo metadata package ${packageIndex} has no dependencies array`);

    const targets = item.targets.map((target, targetIndex): CargoTarget => {
      if (!isRecord(target)) throw new Error(`cargo metadata target ${targetIndex} must be an object`);
      return {
        name: requiredString(target.name, "target.name"),
        kind: stringArray(target.kind, "target.kind"),
        sourcePath: requiredString(target.src_path, "target.src_path"),
      };
    });
    const dependencies = item.dependencies.map((dependency, dependencyIndex): CargoDependency => {
      if (!isRecord(dependency)) throw new Error(`cargo metadata dependency ${dependencyIndex} must be an object`);
      const dependencyKind = dependency.kind;
      const kind = dependencyKind === "build" ? "build" : dependencyKind === "dev" ? "dev" : "normal";
      return {
        name: requiredString(dependency.name, "dependency.name"),
        path: optionalString(dependency.path),
        kind,
      };
    });
    return {
      id: requiredString(item.id, "package.id"),
      name: requiredString(item.name, "package.name"),
      version: requiredString(item.version, "package.version"),
      manifestPath: requiredString(item.manifest_path, "package.manifest_path"),
      description: optionalString(item.description),
      targets,
      features: Object.keys(item.features).sort(),
      dependencies,
    };
  });

  return { workspaceRoot, workspaceMemberIds, packages };
}

function relativePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join("/");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function moduleId(packageName: string, modulePath: string): string {
  return `module:${slug(packageName)}:${modulePath}`;
}

function moduleFingerprint(sourcePath: string | null, fallback: string): string {
  return sourcePath !== null && existsSync(sourcePath) ? hashFile(sourcePath) : hashText(fallback);
}

function moduleBlocks(args: {
  readonly packageName: string;
  readonly sourcePath: string;
  readonly source: string;
  readonly parentDirectory: string;
  readonly parentId: string;
  readonly parentModulePath: string;
  readonly rootPath: string;
}): { readonly blocks: ModuleBlock[]; readonly connections: FactConnection[] } {
  const blocks: ModuleBlock[] = [];
  const connections: FactConnection[] = [];

  function visit(args: {
    readonly packageName: string;
    readonly rootPath: string;
    readonly sourcePath: string;
    readonly source: string;
    readonly parentDirectory: string;
    readonly parentId: string;
    readonly parentModulePath: string;
    readonly declarations?: ReturnType<typeof rustModuleDeclarations>;
  }): void {
    const declarations = args.declarations ?? rustModuleDeclarations(args.source);
    for (const declaration of declarations) {
      const modulePath = args.parentModulePath.length === 0
        ? declaration.name
        : `${args.parentModulePath}::${declaration.name}`;
      const childSourcePath = declaration.inlineChildren === null
        ? resolveModuleSource({
          declaration,
          parentDirectory: args.parentDirectory,
          declarationDirectory: path.dirname(args.sourcePath),
        })
        : args.sourcePath;
      const id = moduleId(args.packageName, modulePath);
      const relativeSourcePath = childSourcePath === null ? null : relativePath(args.rootPath, childSourcePath);
      const fingerprint = moduleFingerprint(childSourcePath, `${relativePath(args.rootPath, args.sourcePath)}:${modulePath}:${declaration.attributes.join("")}`);
      blocks.push({
        id,
        label: declaration.name,
        type: "module",
        packageName: args.packageName,
        modulePath,
        declaredByPath: relativePath(args.rootPath, args.sourcePath),
        parentId: args.parentId,
        children: [],
        sourcePath: relativeSourcePath,
        fingerprint,
        cfgAttributes: declaration.attributes,
        unresolved: declaration.inlineChildren === null && childSourcePath === null,
      });
      connections.push({ id: `contains:${args.parentId}->${id}`, source: args.parentId, target: id, kind: "contains" });

      if (declaration.inlineChildren !== null) {
        visit({
          packageName: args.packageName,
          rootPath: args.rootPath,
          sourcePath: args.sourcePath,
          source: args.source,
          parentDirectory: path.join(args.parentDirectory, declaration.name),
          parentId: id,
          parentModulePath: modulePath,
          declarations: declaration.inlineChildren,
        });
      } else if (childSourcePath !== null) {
        const childSource = readModuleSource(childSourcePath);
        visit({
          packageName: args.packageName,
          rootPath: args.rootPath,
          sourcePath: childSourcePath,
          source: childSource,
          parentDirectory: moduleDirectoryForSource(childSourcePath),
          parentId: id,
          parentModulePath: modulePath,
        });
      }
    }
  }

  visit({
    packageName: args.packageName,
    rootPath: args.rootPath,
    sourcePath: args.sourcePath,
    source: args.source,
    parentDirectory: args.parentDirectory,
    parentId: args.parentId,
    parentModulePath: args.parentModulePath,
  });
  return { blocks, connections };
}

function connectionId(kind: "contains" | "depends_on", source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}

function deriveChildren(blocks: readonly FactBlock[]): FactBlock[] {
  const children = new Map<string, string[]>();
  for (const block of blocks) {
    if (block.parentId === null) continue;
    const current = children.get(block.parentId) ?? [];
    current.push(block.id);
    children.set(block.parentId, current);
  }
  return blocks.map((block) => ({ ...block, children: children.get(block.id) ?? [] }));
}

export function extractCargoMap(args: { readonly repositoryPath: string; readonly projectName?: string }): FactMap {
  const requestedRoot = path.resolve(args.repositoryPath);
  const manifestPath = path.join(requestedRoot, "Cargo.toml");
  if (!existsSync(manifestPath)) {
    const marker = nonCargoProjectMarker(requestedRoot);
    if (marker === null) throw new Error(`No Cargo.toml found at ${relativePath(requestedRoot, manifestPath)}`);
    return extractWithoutCargo({ rootPath: requestedRoot, markerPath: marker, projectName: args.projectName });
  }
  const result = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath], {
    cwd: requestedRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw new Error(`Could not run cargo metadata: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata failed: ${result.stderr.trim()}`);
  const metadataValue: unknown = JSON.parse(result.stdout);
  const metadata = parseMetadata(metadataValue);
  const rootPath = path.resolve(metadata.workspaceRoot);
  const memberIds = new Set(metadata.workspaceMemberIds);
  const packages = metadata.packages
    .filter((pkg) => memberIds.has(pkg.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  const projectLabel = args.projectName ?? path.basename(rootPath);
  const projectId = `workspace:${slug(projectLabel)}`;
  const blocks: FactBlock[] = [];
  const connections: FactConnection[] = [];
  const packageIdByPath = new Map(packages.map((pkg) => [path.resolve(pkg.manifestPath), `crate:${slug(pkg.name)}`]));
  const packageBlockIds = packages.map((pkg) => `crate:${slug(pkg.name)}`);
  const workspaceFingerprint = hashText(packages.map((pkg) => `${pkg.name}:${hashFile(pkg.manifestPath)}`).join("\n"));
  const workspaceBlock: WorkspaceBlock = {
    id: projectId,
    label: projectLabel,
    type: "workspace",
    parentId: null,
    children: [],
    sourcePath: relativePath(rootPath, manifestPath),
    fingerprint: workspaceFingerprint,
    memberCount: packages.length,
  };
  blocks.push(workspaceBlock);

  for (const pkg of packages) {
    const crateId = `crate:${slug(pkg.name)}`;
    const crateBlock: CrateBlock = {
      id: crateId,
      label: pkg.name,
      type: "crate",
      packageName: pkg.name,
      version: pkg.version,
      description: pkg.description,
      parentId: projectId,
      children: [],
      sourcePath: relativePath(rootPath, pkg.manifestPath),
      fingerprint: hashFile(pkg.manifestPath),
    };
    blocks.push(crateBlock);
    connections.push({ id: connectionId("contains", projectId, crateId), source: projectId, target: crateId, kind: "contains" });

    const targets = pkg.targets
      .filter((target) => target.kind.includes("bin"))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const target of targets) {
      const appId = `app:${slug(pkg.name)}:${slug(target.name)}`;
      const entryPath = relativePath(rootPath, target.sourcePath);
      const appBlock: AppBlock = {
        id: appId,
        label: target.name,
        type: "app",
        packageName: pkg.name,
        targetName: target.name,
        targetKind: target.kind.join(", "),
        entryPath,
        parentId: crateId,
        children: [],
        sourcePath: entryPath,
        fingerprint: hashFile(target.sourcePath),
      };
      blocks.push(appBlock);
      connections.push({ id: connectionId("contains", crateId, appId), source: crateId, target: appId, kind: "contains" });
      const source = readModuleSource(target.sourcePath);
      const modules = moduleBlocks({
        packageName: pkg.name,
        sourcePath: target.sourcePath,
        source,
        parentDirectory: moduleDirectoryForSource(target.sourcePath),
        parentId: appId,
        parentModulePath: target.name,
        rootPath,
      });
      blocks.push(...modules.blocks);
      connections.push(...modules.connections);
    }

    const libTarget = pkg.targets.find((target) => target.kind.some((kind) => ["lib", "rlib", "dylib", "cdylib", "staticlib"].includes(kind)));
    if (libTarget !== undefined) {
      const rootModuleId = moduleId(pkg.name, "crate root");
      const rootSourcePath = relativePath(rootPath, libTarget.sourcePath);
      const rootModule: ModuleBlock = {
        id: rootModuleId,
        label: "crate root",
        type: "module",
        packageName: pkg.name,
        modulePath: "crate root",
        declaredByPath: relativePath(rootPath, pkg.manifestPath),
        parentId: crateId,
        children: [],
        sourcePath: rootSourcePath,
        fingerprint: hashFile(libTarget.sourcePath),
        cfgAttributes: [],
        unresolved: false,
      };
      blocks.push(rootModule);
      connections.push({ id: connectionId("contains", crateId, rootModuleId), source: crateId, target: rootModuleId, kind: "contains" });
      const source = readModuleSource(libTarget.sourcePath);
      const modules = moduleBlocks({
        packageName: pkg.name,
        sourcePath: libTarget.sourcePath,
        source,
        parentDirectory: moduleDirectoryForSource(libTarget.sourcePath),
        parentId: rootModuleId,
        parentModulePath: "crate root",
        rootPath,
      });
      blocks.push(...modules.blocks);
      connections.push(...modules.connections);
    }

    for (const featureName of pkg.features) {
      const featureId = `cargo-feature:${slug(pkg.name)}:${slug(featureName)}`;
      const featureBlock: CargoFeatureBlock = {
        id: featureId,
        label: featureName,
        type: "cargo_feature",
        packageName: pkg.name,
        featureName,
        parentId: crateId,
        children: [],
        sourcePath: relativePath(rootPath, pkg.manifestPath),
        fingerprint: hashFile(pkg.manifestPath),
      };
      blocks.push(featureBlock);
      connections.push({ id: connectionId("contains", crateId, featureId), source: crateId, target: featureId, kind: "contains" });
    }
  }

  for (const pkg of packages) {
    const crateId = `crate:${slug(pkg.name)}`;
    const crateIndex = blocks.findIndex((block) => block.id === crateId);
    const crate = blocks[crateIndex];
    if (crate === undefined || crate.type !== "crate") throw new Error(`Missing extracted crate ${pkg.name}`);
    const sourceFingerprints = blocks
      .filter((block) => block.id !== crateId && "packageName" in block && block.packageName === pkg.name)
      .map((block) => `${block.id}:${block.fingerprint}`)
      .sort();
    blocks[crateIndex] = { ...crate, fingerprint: hashText([hashFile(pkg.manifestPath), ...sourceFingerprints].join("\n")) };
  }
  const pythonModules = discoverPythonModules(rootPath);
  const pythonProject = discoverPythonProject(rootPath);
  const pythonFacts = pythonFactBlocks({
    modules: pythonModules,
    project: pythonProject,
    rootPath,
    workspaceId: projectId,
  });
  blocks.push(...pythonFacts.blocks);
  connections.push(...pythonFacts.connections);
  const webModules = discoverWebModules(rootPath);
  const webFacts = webFactBlocks({ modules: webModules, rootPath, workspaceId: projectId });
  blocks.push(...webFacts.blocks);
  connections.push(...webFacts.connections);
  const dotnet = discoverDotnet(rootPath);
  const dotnetFacts = dotnetFactBlocks({ workspace: dotnet, rootPath, workspaceId: projectId });
  blocks.push(...dotnetFacts.blocks);
  connections.push(...dotnetFacts.connections);
  const goPackages = discoverGoPackages(rootPath);
  const goFacts = goFactBlocks({ packages: goPackages, rootPath, workspaceId: projectId });
  blocks.push(...goFacts.blocks);
  connections.push(...goFacts.connections);
  const phpPackages = discoverPhpPackages(rootPath);
  const phpFacts = phpFactBlocks({ packages: phpPackages, rootPath, workspaceId: projectId });
  blocks.push(...phpFacts.blocks);
  connections.push(...phpFacts.connections);
  const rubyPackages = discoverRubyPackages(rootPath);
  const rubyFacts = rubyFactBlocks({ packages: rubyPackages, rootPath, workspaceId: projectId });
  blocks.push(...rubyFacts.blocks);
  connections.push(...rubyFacts.connections);
  const cppTargets = discoverCppTargets(rootPath);
  const cppFacts = cppFactBlocks({ targets: cppTargets, rootPath, workspaceId: projectId });
  blocks.push(...cppFacts.blocks);
  connections.push(...cppFacts.connections);
  const jvm = discoverJvm(rootPath);
  const jvmFacts = jvmFactBlocks({ workspace: jvm, rootPath, workspaceId: projectId });
  const configInfra = discoverConfigInfra(rootPath);
  const configInfraFacts = configInfraFactBlocks({ workspace: configInfra, rootPath, workspaceId: projectId });
  blocks.push(...jvmFacts.blocks);
  connections.push(...jvmFacts.connections);
  const swiftTargets = discoverSwiftTargets(rootPath);
  const swiftFacts = swiftFactBlocks({ targets: swiftTargets, rootPath, workspaceId: projectId });
  blocks.push(...configInfraFacts.blocks);
  connections.push(...configInfraFacts.connections);
  blocks.push(...swiftFacts.blocks);
  connections.push(...swiftFacts.connections);
  const finalWorkspaceFingerprint = hashText([
    ...packages.map((pkg) => {
      const crate = blocks.find((block) => block.id === `crate:${slug(pkg.name)}`);
      return `${pkg.name}:${crate?.fingerprint ?? hashFile(pkg.manifestPath)}`;
    }),
    ...(pythonProject === null
      ? []
      : [`python-project:${pythonProject.name}:${hashFile(pythonProject.manifestPath)}`]),
    ...pythonModules.map((module) => `python:${module.name}:${hashFile(module.path)}`),
    ...webModules.map((module) => `web:${module.name}:${hashFile(module.path)}`),
    ...dotnet.projects.map((project) => `dotnet:${project.name}:${hashFile(project.path)}`),
    ...dotnet.files.map((file) => `dotnet:${relativePath(rootPath, file.path)}:${hashFile(file.path)}`),
    ...goPackages.flatMap((pkg) =>
      pkg.files.map((file) => `go:${pkg.importPath}:${hashFile(file.path)}`),
    ),
    ...phpPackages.flatMap((pkg) =>
      pkg.files.map((file) => `php:${pkg.importPath}:${path.basename(file.path)}:${hashFile(file.path)}`),
    ),
    ...rubyPackages.flatMap((pkg) =>
      pkg.files.map((file) => `ruby:${pkg.importPath}:${path.basename(file.path)}:${hashFile(file.path)}`),
    ),
    ...cppTargets.flatMap((target) =>
      target.files.flatMap((file) => {
        try {
          return [`cpp:${target.name}:${path.basename(file.path)}:${hashFile(file.path)}`];
        } catch {
          return [];
        }
      }),
    ),
    ...jvmFingerprintInputs(rootPath, jvm),
    ...configInfra.files.map((file) => `config-infra:${file.path}:${hashFile(path.join(rootPath, file.path))}`),
    ...swiftTargets.flatMap((target) =>
      target.files.map((file) => `swift:${target.name}:${path.basename(file.path)}:${hashFile(file.path)}`),
    ),
  ].sort().join("\n"));
  const workspaceIndex = blocks.findIndex((block) => block.id === projectId);
  if (workspaceIndex >= 0) blocks[workspaceIndex] = { ...workspaceBlock, fingerprint: finalWorkspaceFingerprint || workspaceFingerprint };

  for (const pkg of packages) {
    const sourceId = `crate:${slug(pkg.name)}`;
    for (const dependency of pkg.dependencies) {
      if (dependency.kind === "dev" || dependency.path === null) continue;
      const dependencyManifest = path.resolve(dependency.path, "Cargo.toml");
      const targetId = packageIdByPath.get(dependencyManifest);
      if (targetId === undefined || targetId === sourceId) continue;
      const kind = dependency.kind === "build" ? "build" : "normal";
      const id = connectionId("depends_on", sourceId, targetId);
      if (connections.some((connection) => connection.id === id)) continue;
      connections.push({ id, source: sourceId, target: targetId, kind: "depends_on", dependencyScope: kind });
    }
  }

  const completedBlocks = deriveChildren(blocks);
  const workspaceChildren = completedBlocks.find((block) => block.id === projectId)?.children ?? packageBlockIds;
  const groups: FactGroup[] = [{
    id: "group:crates",
    label: "Workspace crates",
    memberIds: workspaceChildren.filter((id) => id.startsWith("crate:")),
  }];
  const stats = {
    blocks: completedBlocks.length,
    connections: connections.length,
    crates: completedBlocks.filter((block) => block.type === "crate").length,
    apps: completedBlocks.filter((block) => block.type === "app").length,
    modules: completedBlocks.filter((block) => block.type === "module").length,
    cargoFeatures: completedBlocks.filter((block) => block.type === "cargo_feature").length,
  };

  return {
    schemaVersion: 1,
    project: { id: projectId, name: projectLabel, rootPath: "." },
    blocks: completedBlocks,
    connections,
    groups,
    stats,
  };
}

const namedProjectMarkers = [
  "go.mod",
  "go.work",
  "composer.json",
  "Gemfile",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "CMakeLists.txt",
  "Dockerfile",
  "Package.swift",
];

function nonCargoProjectMarker(root: string): string | null {
  for (const name of namedProjectMarkers) {
    const candidate = path.join(root, name);
    if (isFile(candidate)) return candidate;
  }
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const candidate = path.join(root, name);
    if (name.endsWith(".xcodeproj") && isDirectory(candidate)) return candidate;
    if (!isFile(candidate)) continue;
    const extension = path.extname(name).toLowerCase();
    const lowerName = name.toLowerCase();
    if (extension === ".sln" || extension === ".csproj" || extension === ".vbproj"
      || extension === ".yaml" || extension === ".yml" || extension === ".tf"
      || extension === ".tfvars" || extension === ".hcl" || lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) return candidate;
  }
  return null;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function extractWithoutCargo(args: { readonly rootPath: string; readonly markerPath: string; readonly projectName?: string }): FactMap {
  const rootPath = args.rootPath;
  const projectLabel = args.projectName ?? path.basename(rootPath);
  const projectId = `workspace:${slug(projectLabel)}`;
  const pythonModules = discoverPythonModules(rootPath);
  const pythonProject = discoverPythonProject(rootPath);
  const pythonFacts = pythonFactBlocks({
    modules: pythonModules,
    project: pythonProject,
    rootPath,
    workspaceId: projectId,
  });
  const webModules = discoverWebModules(rootPath);
  const webFacts = webFactBlocks({ modules: webModules, rootPath, workspaceId: projectId });
  const dotnet = discoverDotnet(rootPath);
  const dotnetFacts = dotnetFactBlocks({ workspace: dotnet, rootPath, workspaceId: projectId });
  const goPackages = discoverGoPackages(rootPath);
  const goFacts = goFactBlocks({ packages: goPackages, rootPath, workspaceId: projectId });
  const phpPackages = discoverPhpPackages(rootPath);
  const phpFacts = phpFactBlocks({ packages: phpPackages, rootPath, workspaceId: projectId });
  const rubyPackages = discoverRubyPackages(rootPath);
  const rubyFacts = rubyFactBlocks({ packages: rubyPackages, rootPath, workspaceId: projectId });
  const cppTargets = discoverCppTargets(rootPath);
  const cppFacts = cppFactBlocks({ targets: cppTargets, rootPath, workspaceId: projectId });
  const jvm = discoverJvm(rootPath);
  const jvmFacts = jvmFactBlocks({ workspace: jvm, rootPath, workspaceId: projectId });
  const configInfra = discoverConfigInfra(rootPath);
  const configInfraFacts = configInfraFactBlocks({ workspace: configInfra, rootPath, workspaceId: projectId });
  const swiftTargets = discoverSwiftTargets(rootPath);
  const swiftFacts = swiftFactBlocks({ targets: swiftTargets, rootPath, workspaceId: projectId });
  const fingerprint = hashText([
    ...(pythonProject === null
      ? []
      : [`python-project:${pythonProject.name}:${hashFile(pythonProject.manifestPath)}`]),
    ...pythonModules.map((module) => `python:${module.name}:${hashFile(module.path)}`),
    ...webModules.map((module) => `web:${module.name}:${hashFile(module.path)}`),
    ...dotnet.projects.map((project) => `dotnet:${project.name}:${hashFile(project.path)}`),
    ...dotnet.files.map((file) => `dotnet:${relativePath(rootPath, file.path)}:${hashFile(file.path)}`),
    ...goPackages.flatMap((pkg) =>
      pkg.files.map((file) => `go:${pkg.importPath}:${hashFile(file.path)}`),
    ),
    ...phpPackages.flatMap((pkg) =>
      pkg.files.map((file) => `php:${pkg.importPath}:${path.basename(file.path)}:${hashFile(file.path)}`),
    ),
    ...rubyPackages.flatMap((pkg) =>
      pkg.files.map((file) => `ruby:${pkg.importPath}:${path.basename(file.path)}:${hashFile(file.path)}`),
    ),
    ...cppTargets.flatMap((target) =>
      target.files.flatMap((file) => {
        try {
          return [`cpp:${target.name}:${path.basename(file.path)}:${hashFile(file.path)}`];
        } catch {
          return [];
        }
      }),
    ),
    ...jvmFingerprintInputs(rootPath, jvm),
    ...configInfra.files.map((file) => `config-infra:${file.path}:${hashFile(path.join(rootPath, file.path))}`),
    ...swiftTargets.flatMap((target) =>
      target.files.map((file) => `swift:${target.name}:${path.basename(file.path)}:${hashFile(file.path)}`),
    ),
  ].sort().join("\n"));
  const blocks: FactBlock[] = [{
    id: projectId,
    label: projectLabel,
    type: "workspace",
    parentId: null,
    children: [],
    sourcePath: relativePath(rootPath, args.markerPath),
    fingerprint,
    memberCount: 0,
  }, ...pythonFacts.blocks, ...webFacts.blocks, ...dotnetFacts.blocks, ...goFacts.blocks, ...phpFacts.blocks, ...rubyFacts.blocks, ...cppFacts.blocks, ...jvmFacts.blocks, ...configInfraFacts.blocks, ...swiftFacts.blocks];
  const connections = [...pythonFacts.connections, ...webFacts.connections, ...dotnetFacts.connections, ...goFacts.connections, ...phpFacts.connections, ...rubyFacts.connections, ...cppFacts.connections, ...jvmFacts.connections, ...configInfraFacts.connections, ...swiftFacts.connections];
  const completedBlocks = deriveChildren(blocks);
  const workspaceChildren = completedBlocks.find((block) => block.id === projectId)?.children ?? [];
  const groups: FactGroup[] = [{
    id: "group:crates",
    label: "Workspace crates",
    memberIds: workspaceChildren.filter((id) => id.startsWith("crate:")),
  }];
  const stats = {
    blocks: completedBlocks.length,
    connections: connections.length,
    crates: completedBlocks.filter((block) => block.type === "crate").length,
    apps: completedBlocks.filter((block) => block.type === "app").length,
    modules: completedBlocks.filter((block) => block.type === "module").length,
    cargoFeatures: completedBlocks.filter((block) => block.type === "cargo_feature").length,
  };
  return {
    schemaVersion: 1,
    project: { id: projectId, name: projectLabel, rootPath: "." },
    blocks: completedBlocks,
    connections,
    groups,
    stats,
  };
}
