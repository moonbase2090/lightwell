mod extract;
mod facts;
mod manifest;
mod metadata;
mod notes;
mod rust_source;

pub use extract::{extract_cargo_map, MapExtractionError};
pub use facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock, MAP_SCHEMA_VERSION,
};
pub use metadata::{
    discover_cargo_workspace, CargoDependency, CargoDependencyKind, CargoDiscoveryError,
    CargoPackage, CargoTarget, CargoWorkspace, RustModule,
};
pub use notes::{
    list_project_notes, project_notes_for_map, remove_project_note, set_project_note, NotesError,
    ProjectNoteView,
};
