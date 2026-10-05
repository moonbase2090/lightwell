mod editor;
mod extract;
mod facts;
mod manifest;
mod metadata;
mod rust_source;

pub use editor::{
    open_block, EditorError, EditorSettings, EditorTarget, SourcePosition, EDITOR_TEMPLATE_PRESETS,
};
pub use extract::{extract_cargo_map, MapExtractionError};
pub use facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock, MAP_SCHEMA_VERSION,
};
pub use metadata::{
    discover_cargo_workspace, CargoDependency, CargoDependencyKind, CargoDiscoveryError,
    CargoPackage, CargoTarget, CargoWorkspace, RustModule,
};
