mod diff;
mod editor;
mod extract;
mod facts;
pub mod language_pack;
mod manifest;
mod metadata;
mod notes;
mod path_confinement;
mod python_source;
mod rust_source;
mod typescript_source;
mod watch;

pub use diff::{
    block_diff, block_diff_for, commit_changes, commit_changes_for,
    filter_commits_that_are_ancestors, recent_commits, BlockChange, BlockDiffDocument,
    CommitChanges, CommitSummary, ConnectionChange, DiffError, FileChange,
};
pub use editor::{
    open_block, open_target, resolve_block_target, resolve_block_target_in_map, EditorError,
    EditorSettings, EditorTarget, EditorTemplatePreset, SourcePosition, EDITOR_TEMPLATE_PRESETS,
};
pub use extract::{extract_cargo_map, project_manifest, MapExtractionError};
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
