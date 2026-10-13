mod editor;
mod extract;
mod facts;
pub mod language_pack;
mod manifest;
mod metadata;
mod notes;
mod path_confinement;
mod rust_source;
mod watch;

pub use editor::{
    open_block, resolve_block_target, EditorError, EditorSettings, EditorTarget,
    EditorTemplatePreset, SourcePosition, EDITOR_TEMPLATE_PRESETS,
};
pub use extract::{extract_cargo_map, MapExtractionError};
pub use facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock, MAP_SCHEMA_VERSION,
};
pub use language_pack::RUST_WORKSPACE_PACK_ID;
pub use metadata::{
    discover_cargo_workspace, discover_cargo_workspace_manifest_only, CargoDependency,
    CargoDependencyKind, CargoDiscoveryError, CargoPackage, CargoTarget, CargoWorkspace,
    RustModule,
};
pub use notes::{
    list_project_notes, project_notes_for_map, remove_project_note, set_project_note,
    set_project_note_for_map, update_project_note_text, NotesError, ProjectNoteView,
};

pub use watch::{MapWatchError, MapWatcher};
