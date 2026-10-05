mod extract;
mod facts;
mod manifest;
mod metadata;
mod rust_source;
mod watch;

pub use extract::{extract_cargo_map, MapExtractionError};
pub use facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock, MAP_SCHEMA_VERSION,
};
pub use metadata::{
    discover_cargo_workspace, CargoDependency, CargoDependencyKind, CargoDiscoveryError,
    CargoPackage, CargoTarget, CargoWorkspace, RustModule,
};
pub use watch::{MapWatchError, MapWatcher};
