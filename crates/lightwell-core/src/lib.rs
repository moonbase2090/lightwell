mod cpp_source;
mod config_infra_source;
mod diff;
mod dotnet_source;
mod editor;
mod extract;
mod facts;
mod go_source;
mod jvm_source;
pub mod language_pack;
mod manifest;
mod metadata;
mod notes;
mod path_confinement;
mod php_source;
mod python_source;
mod ruby_source;
mod rust_source;
mod typescript_source;
mod watch;

pub use diff::{
    block_diff, block_diff_for, commit_changes, commit_changes_for,
    filter_commits_that_are_ancestors, path_diff_for, recent_commits, resolve_commit_range,
    BlockChange, BlockChangeState, BlockDiffDocument, CommitChanges, CommitRangePreset,
    CommitSummary, ConnectionChange, DiffError, FileChange, ResolvedCommitRange,
};
pub use editor::{
    open_block, open_target, resolve_block_target, resolve_block_target_in_map, EditorError,
    EditorSettings, EditorTarget, EditorTemplatePreset, SourcePosition, EDITOR_TEMPLATE_PRESETS,
};
pub use extract::{
    discover_project_workspace, extract_cargo_map, project_manifest, MapExtractionError,
};
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
    commit_project_note, list_project_notes, mark_project_note_reviewed, project_note_git_status,
    project_notes_for_map, remove_project_note, remove_stale_project_notes, set_project_note,
    set_project_note_for_map, update_project_note_text, NoteCommitResult, NotesError,
    NotesGitFileState, NotesGitStatus, ProjectNoteView,
};

pub use watch::{MapWatchError, MapWatcher};
