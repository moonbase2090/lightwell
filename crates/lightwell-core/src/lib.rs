mod facts;
mod metadata;

pub use facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock, MAP_SCHEMA_VERSION,
};
pub use metadata::{
    discover_cargo_workspace, CargoDependency, CargoDependencyKind, CargoMetadataError,
    CargoPackage, CargoTarget, CargoWorkspace,
};
