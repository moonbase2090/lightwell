export const mapSchemaVersion = 1;

export type FactBlockType = "workspace" | "crate" | "app" | "module" | "cargo_feature";
export type RelationKind = "contains" | "depends_on";
export type AnnotationKind = "APP" | "CRATE" | "MODULE" | "FEATURE";
export type AnnotationStatus = "ready" | "wip" | "deprecated";

interface FactBlockBase {
  readonly id: string;
  readonly label: string;
  readonly type: FactBlockType;
  readonly parentId: string | null;
  readonly children: readonly string[];
  readonly sourcePath: string | null;
  readonly fingerprint: string;
}

export interface WorkspaceBlock extends FactBlockBase {
  readonly type: "workspace";
  readonly memberCount: number;
}

export interface CrateBlock extends FactBlockBase {
  readonly type: "crate";
  readonly packageName: string;
  readonly version: string;
  readonly description: string | null;
}

export interface AppBlock extends FactBlockBase {
  readonly type: "app";
  readonly packageName: string;
  readonly targetName: string;
  readonly entryPath: string;
  readonly targetKind: string;
}

export interface ModuleBlock extends FactBlockBase {
  readonly type: "module";
  readonly packageName: string;
  readonly modulePath: string;
  readonly declaredByPath: string;
  readonly cfgAttributes: readonly string[];
  readonly unresolved: boolean;
  /** Omitted for Rust modules; web (`typescript`, `javascript`, `html`, `css`, …) and `python` when applicable. */
  readonly language?: string;
}

export interface CargoFeatureBlock extends FactBlockBase {
  readonly type: "cargo_feature";
  readonly packageName: string;
  readonly featureName: string;
}

export type FactBlock = WorkspaceBlock | CrateBlock | AppBlock | ModuleBlock | CargoFeatureBlock;

export interface ContainsConnection {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "contains";
}

export interface DependsOnConnection {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "depends_on";
  readonly dependencyScope: "normal" | "build";
}

export type FactConnection = ContainsConnection | DependsOnConnection;

export interface FactGroup {
  readonly id: string;
  readonly label: string;
  readonly memberIds: readonly string[];
}

export interface MapStats {
  readonly blocks: number;
  readonly connections: number;
  readonly crates: number;
  readonly apps: number;
  readonly modules: number;
  readonly cargoFeatures: number;
}

export interface FactMap {
  readonly schemaVersion: number;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly rootPath: ".";
  };
  readonly blocks: readonly FactBlock[];
  readonly connections: readonly FactConnection[];
  readonly groups: readonly FactGroup[];
  readonly stats: MapStats;
}

export interface BlockAnnotation {
  readonly description: string;
  readonly kind: AnnotationKind;
  readonly status: AnnotationStatus;
  readonly sourceFingerprint: string;
}

export interface FeatureAnnotation {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: "FEATURE";
  readonly status: AnnotationStatus;
  readonly memberIds: readonly string[];
  readonly sourceFingerprints: Readonly<Record<string, string>>;
  readonly pathLabel: string;
}

export interface AnnotationOverlay {
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly blocks: Readonly<Record<string, BlockAnnotation>>;
  readonly features: readonly FeatureAnnotation[];
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly featureIds: readonly string[];
  }[];
}

export type DisplayBlock = FactBlock & {
  readonly description: string;
  readonly annotationKind: AnnotationKind;
  readonly status: AnnotationStatus;
  readonly annotationState: "current" | "changed" | "missing";
  readonly virtual: false;
};

export interface DisplayFeature {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly annotationKind: "FEATURE";
  readonly status: AnnotationStatus;
  readonly memberIds: readonly string[];
  readonly pathLabel: string;
  readonly annotationState: "current" | "changed" | "missing";
  readonly virtual: true;
}

export type DisplayNode = DisplayBlock | DisplayFeature;

export interface ResolvedMap {
  readonly facts: FactMap;
  readonly annotations: AnnotationOverlay;
  readonly nodes: readonly DisplayNode[];
  readonly connections: readonly FactConnection[];
  readonly groups: readonly FactGroup[];
  readonly nodeById: ReadonlyMap<string, DisplayNode>;
  readonly blockById: ReadonlyMap<string, DisplayBlock>;
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
}
