import type {
  AnnotationOverlay,
  AnnotationStatus,
  BlockAnnotation,
  FactBlock,
  FactConnection,
  FactGroup,
  FactMap,
  FeatureAnnotation,
  MapStats,
  ResolvedMap,
  WorkspaceBlock,
} from "./model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBlockBase(value: Record<string, unknown>): boolean {
  return isString(value.id)
    && isString(value.label)
    && (value.parentId === null || isString(value.parentId))
    && isStringArray(value.children)
    && isStringOrNull(value.sourcePath)
    && isString(value.fingerprint);
}

function isFactBlock(value: unknown): value is FactBlock {
  if (!isRecord(value) || !isBlockBase(value)) return false;
  switch (value.type) {
    case "workspace":
      return Number.isInteger(value.memberCount);
    case "crate":
      return isString(value.packageName) && isString(value.version) && isStringOrNull(value.description);
    case "app":
      return isString(value.packageName)
        && isString(value.targetName)
        && isString(value.entryPath)
        && isString(value.targetKind);
    case "module":
      return isString(value.packageName)
        && isString(value.modulePath)
        && isString(value.declaredByPath)
        && isStringArray(value.cfgAttributes)
        && typeof value.unresolved === "boolean";
    case "cargo_feature":
      return isString(value.packageName) && isString(value.featureName);
    default:
      return false;
  }
}

function isFactConnection(value: unknown): value is FactConnection {
  if (!isRecord(value) || !isString(value.id) || !isString(value.source) || !isString(value.target)) return false;
  if (value.kind === "contains") return true;
  return value.kind === "depends_on" && (value.dependencyScope === "normal" || value.dependencyScope === "build");
}

function isFactGroup(value: unknown): value is FactGroup {
  return isRecord(value) && isString(value.id) && isString(value.label) && isStringArray(value.memberIds);
}

function isStats(value: unknown): value is MapStats {
  return isRecord(value)
    && ["blocks", "connections", "crates", "apps", "modules", "cargoFeatures"].every((key) => isNumber(value[key]));
}

export function parseFactMap(value: unknown): FactMap {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isRecord(value.project)
    || !isString(value.project.id)
    || !isString(value.project.name)
    || value.project.rootPath !== "."
    || !Array.isArray(value.blocks)
    || !value.blocks.every(isFactBlock)
    || !Array.isArray(value.connections)
    || !value.connections.every(isFactConnection)
    || !Array.isArray(value.groups)
    || !value.groups.every(isFactGroup)
    || !isStats(value.stats)) {
    throw new Error("The facts file does not match Lightwell schema v1.");
  }
  return {
    schemaVersion: 1,
    project: { id: value.project.id, name: value.project.name, rootPath: "." },
    blocks: value.blocks,
    connections: value.connections,
    groups: value.groups,
    stats: value.stats,
  };
}

function isAnnotationKind(value: unknown): value is BlockAnnotation["kind"] {
  return value === "APP" || value === "CRATE" || value === "MODULE" || value === "FEATURE";
}

function isStatus(value: unknown): value is AnnotationStatus {
  return value === "ready" || value === "wip" || value === "deprecated";
}

function isBlockAnnotation(value: unknown): value is BlockAnnotation {
  return isRecord(value)
    && isString(value.description)
    && isAnnotationKind(value.kind)
    && isStatus(value.status)
    && isString(value.sourceFingerprint);
}

function isFeatureAnnotation(value: unknown): value is FeatureAnnotation {
  if (!isRecord(value) || !isString(value.id) || !isString(value.label) || !isString(value.description)
    || value.kind !== "FEATURE" || !isStatus(value.status) || !isStringArray(value.memberIds)
    || !isString(value.pathLabel) || !isRecord(value.sourceFingerprints)) return false;
  return Object.values(value.sourceFingerprints).every(isString);
}

function isOverlayGroup(value: unknown): value is AnnotationOverlay["groups"][number] {
  return isRecord(value) && isString(value.id) && isString(value.label) && isStringArray(value.featureIds);
}

export function parseAnnotationOverlay(value: unknown): AnnotationOverlay {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isString(value.projectId)
    || !isRecord(value.blocks)
    || !Object.values(value.blocks).every(isBlockAnnotation)
    || !Array.isArray(value.features)
    || !value.features.every(isFeatureAnnotation)
    || !Array.isArray(value.groups)
    || !value.groups.every(isOverlayGroup)) {
    throw new Error("The notes file does not match Lightwell schema v1.");
  }
  const blocks: Record<string, BlockAnnotation> = {};
  for (const [id, annotation] of Object.entries(value.blocks)) {
    if (!isBlockAnnotation(annotation)) throw new Error(`Invalid block annotation: ${id}`);
    blocks[id] = annotation;
  }
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    blocks,
    features: value.features,
    groups: value.groups,
  };
}

function annotationKindFor(block: FactBlock): BlockAnnotation["kind"] {
  switch (block.type) {
    case "workspace":
    case "app":
      return "APP";
    case "crate":
      return "CRATE";
    case "module":
      return "MODULE";
    case "cargo_feature":
      return "FEATURE";
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

export function resolveMap(facts: FactMap, annotations: AnnotationOverlay): ResolvedMap {
  if (facts.project.id !== annotations.projectId) throw new Error("Facts and annotations belong to different projects.");
  const blockById = new Map<string, ReturnType<typeof mapBlock>>();
  const nodes = facts.blocks.map((block) => {
    const annotation = annotations.blocks[block.id];
    const expectedKind = annotationKindFor(block);
    if (annotation !== undefined && annotation.kind !== expectedKind) {
      throw new Error(`Annotation kind for ${block.id} must be ${expectedKind}.`);
    }
    const state = annotation === undefined ? "missing" : annotation.sourceFingerprint === block.fingerprint ? "current" : "changed";
    const display = mapBlock(block, annotation?.description ?? "No description is written yet.", annotation?.kind ?? expectedKind, annotation?.status ?? "wip", state);
    blockById.set(block.id, display);
    return display;
  });
  const blockIds = new Set(facts.blocks.map((block) => block.id));
  const featureNodes = annotations.features.map((feature) => {
    const changed = feature.memberIds.some((memberId) => {
      const current = facts.blocks.find((block) => block.id === memberId);
      return current === undefined || feature.sourceFingerprints[memberId] !== current.fingerprint;
    });
    return {
      id: feature.id,
      label: feature.label,
      description: feature.description,
      annotationKind: "FEATURE" as const,
      status: feature.status,
      memberIds: feature.memberIds,
      pathLabel: feature.pathLabel,
      annotationState: changed ? "changed" as const : feature.memberIds.every((id) => blockIds.has(id)) ? "current" as const : "missing" as const,
      virtual: true as const,
    };
  });
  const childrenByParent = new Map<string, readonly string[]>();
  for (const block of facts.blocks) childrenByParent.set(block.id, block.children);
  const allNodes = [...nodes, ...featureNodes];
  return {
    facts,
    annotations,
    nodes: allNodes,
    connections: facts.connections,
    groups: facts.groups,
    nodeById: new Map(allNodes.map((node) => [node.id, node])),
    blockById,
    childrenByParent,
  };
}

function mapBlock(
  block: FactBlock,
  description: string,
  annotationKind: BlockAnnotation["kind"],
  status: AnnotationStatus,
  annotationState: "current" | "changed" | "missing",
) {
  return { ...block, description, annotationKind, status, annotationState, virtual: false as const };
}
