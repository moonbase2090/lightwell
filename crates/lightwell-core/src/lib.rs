mod editor;
mod extract;
mod facts;
mod manifest;
mod metadata;
mod notes;
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
pub use metadata::{
    discover_cargo_workspace, CargoDependency, CargoDependencyKind, CargoDiscoveryError,
    CargoPackage, CargoTarget, CargoWorkspace, RustModule,
};
pub use notes::{
    list_project_notes, project_notes_for_map, remove_project_note, set_project_note,
    set_project_note_for_map, update_project_note_text, NotesError, ProjectNoteView,
};

pub use watch::{MapWatchError, MapWatcher};
