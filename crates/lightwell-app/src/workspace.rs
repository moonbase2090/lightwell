use lightwell_core::{
    block_diff, commit_changes, extract_cargo_map, open_block, project_notes_for_map,
    recent_commits, remove_project_note, resolve_block_target, set_project_note_for_map,
    update_project_note_text, BlockDiffDocument, CommitChanges, CommitSummary, EditorSettings,
    EditorTemplatePreset, FactMap, MapWatchError, MapWatcher, NotesError, ProjectNoteView,
    EDITOR_TEMPLATE_PRESETS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_RECENT_WORKSPACES: usize = 10;
const MAX_EDITOR_TEMPLATE_LENGTH: usize = 4096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMapDocument {
    facts: FactMap,
    annotations: Value,
    project_notes: ProjectNotesState,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectNotesState {
    Ready { notes: Vec<ProjectNoteView> },
    Error { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileDocument {
    path: String,
    content: String,
    line: usize,
    column: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMapUpdate {
    workspace_id: String,
    document: WorkspaceMapDocument,
}

#[derive(Clone, Default)]
pub struct WorkspaceWatchers(Arc<Mutex<HashMap<PathBuf, Arc<RwLock<FactMap>>>>>);

impl WorkspaceWatchers {
    fn current_map(&self, root: &Path) -> Result<FactMap, String> {
        let current = self
            .0
            .lock()
            .map_err(|_| "The workspace watcher registry is unavailable.".to_owned())?
            .get(root)
            .cloned();
        match current {
            Some(current) => current
                .read()
                .map(|facts| facts.clone())
                .map_err(|_| "The workspace map cache is unavailable.".to_owned()),
            None => extract_cargo_map(root, None).map_err(|error| error.to_string()),
        }
    }
}

/// Commits offered by the commit picker.
const COMMIT_PICKER_LIMIT: usize = 50;

// Git and map work runs off the UI thread; a synchronous command blocks the window.
#[tauri::command(async)]
pub fn recent_workspace_commits(path: String) -> Result<Vec<CommitSummary>, String> {
    let root = workspace_root(&path)?;
    recent_commits(&root, COMMIT_PICKER_LIMIT).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn workspace_commit_changes(
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
    commit: String,
) -> Result<CommitChanges, String> {
    let root = workspace_root(&path)?;
    let map = watchers.current_map(&root)?;
    commit_changes(&root, &map, &commit).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn workspace_block_diff(
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
    commit: String,
    block_id: String,
) -> Result<BlockDiffDocument, String> {
    let root = workspace_root(&path)?;
    let map = watchers.current_map(&root)?;
    block_diff(&root, &map, &commit, &block_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn recent_workspaces(app: AppHandle) -> Result<Vec<WorkspaceEntry>, String> {
    read_recent_workspaces(&recent_workspaces_path(&app)?)
}

// Commands that run cargo metadata, extract maps, read sources, or launch
// editors use `async` so Tauri runs them off the UI thread; a synchronous
// command blocks the window until it returns.
#[tauri::command(async)]
pub fn open_workspace(path: String) -> Result<WorkspaceEntry, String> {
    let root = workspace_root(&path)?;
    Ok(WorkspaceEntry {
        id: root.to_string_lossy().into_owned(),
        label: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string()),
    })
}

#[tauri::command(async)]
pub fn load_workspace_map(app: AppHandle, path: String) -> Result<WorkspaceMapDocument, String> {
    let root = workspace_root(&path)?;
    let facts = extract_cargo_map(&root, None).map_err(|error| error.to_string())?;
    remember_workspace(&app, &root, &facts)?;
    Ok(workspace_map_document(&root, facts))
}

#[tauri::command(async)]
pub fn inspect_block(
    workspace_path: String,
    block_id: String,
) -> Result<SourceFileDocument, String> {
    let root = workspace_root(&workspace_path)?;
    let target = resolve_block_target(&root, &block_id).map_err(|error| error.to_string())?;
    let content = fs::read_to_string(&target.path).map_err(|error| {
        format!(
            "Could not read source file {}: {error}",
            target.path.display()
        )
    })?;
    let relative_path = target.path.strip_prefix(&root).map_err(|_| {
        format!(
            "Source file {} resolves outside the Rust workspace.",
            target.path.display()
        )
    })?;
    Ok(SourceFileDocument {
        path: relative_path.to_string_lossy().into_owned(),
        content,
        line: target.position.line(),
        column: target.position.column(),
    })
}

#[tauri::command(async)]
pub fn open_block_in_editor(
    app: AppHandle,
    workspace_path: String,
    block_id: String,
) -> Result<(), String> {
    let root = workspace_root(&workspace_path)?;
    let settings = read_editor_settings(&editor_settings_path(&app)?)?;
    open_block(&root, &block_id, &settings).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_editor_settings(app: AppHandle) -> Result<EditorSettings, String> {
    read_editor_settings(&editor_settings_path(&app)?)
}

#[tauri::command]
pub fn save_editor_settings(
    app: AppHandle,
    settings: EditorSettings,
) -> Result<EditorSettings, String> {
    let settings = normalize_editor_settings(settings)?;
    write_editor_settings(&editor_settings_path(&app)?, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn editor_template_presets() -> Vec<EditorTemplatePreset> {
    EDITOR_TEMPLATE_PRESETS.to_vec()
}

#[tauri::command(async)]
pub fn watch_workspace(
    app: AppHandle,
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
) -> Result<WorkspaceMapDocument, String> {
    let root = workspace_root(&path)?;
    start_workspace_watcher(&app, watchers.inner(), root)
}

#[tauri::command(async)]
pub fn add_workspace_note(
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
    block_id: String,
    text: String,
) -> Result<ProjectNotesState, String> {
    let root = workspace_root(&path)?;
    let facts = watchers.current_map(&root)?;
    set_project_note_for_map(&root, &facts, &block_id, &text)
        .map(|notes| ProjectNotesState::Ready { notes })
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn edit_workspace_note(
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
    block_id: String,
    text: String,
) -> Result<ProjectNotesState, String> {
    let root = workspace_root(&path)?;
    let facts = watchers.current_map(&root)?;
    let notes = match set_project_note_for_map(&root, &facts, &block_id, &text) {
        Ok(notes) => notes,
        Err(NotesError::BlockNotFound(_)) => {
            update_project_note_text(&root, &facts, &block_id, &text)
                .map_err(|error| error.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(ProjectNotesState::Ready { notes })
}

#[tauri::command(async)]
pub fn remove_workspace_note(
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
    block_id: String,
) -> Result<ProjectNotesState, String> {
    let root = workspace_root(&path)?;
    let facts = watchers.current_map(&root)?;
    remove_project_note(&root, &block_id).map_err(|error| error.to_string())?;
    project_notes_for_map(&root, &facts)
        .map(|notes| ProjectNotesState::Ready { notes })
        .map_err(|error| error.to_string())
}

fn start_workspace_watcher(
    app: &AppHandle,
    watchers: &WorkspaceWatchers,
    root: PathBuf,
) -> Result<WorkspaceMapDocument, String> {
    let mut active = watchers
        .0
        .lock()
        .map_err(|_| "The workspace watcher registry is unavailable.".to_owned())?;
    if let Some(current) = active.get(&root) {
        let facts = current
            .read()
            .map_err(|_| "The workspace map cache is unavailable.".to_owned())?
            .clone();
        return Ok(workspace_map_document(&root, facts));
    }

    let mut watcher = MapWatcher::new(&root, None).map_err(|error| error.to_string())?;
    let current = Arc::new(RwLock::new(watcher.current_map().clone()));
    let thread_current = Arc::clone(&current);
    let thread_registry = watchers.clone();
    let thread_app = app.clone();
    let thread_root = root.clone();
    active.insert(root.clone(), Arc::clone(&current));

    let spawn_result = thread::Builder::new()
        .name("lightwell-workspace-watcher".to_owned())
        .spawn(move || {
            forward_map_changes(&mut watcher, &thread_current, &thread_root, |update| {
                if let Err(error) = thread_app.emit("workspace-map-changed", update) {
                    eprintln!("Lightwell could not send a workspace map update: {error}");
                }
                true
            });

            match thread_registry.0.lock() {
                Ok(mut active) => {
                    if active
                        .get(&thread_root)
                        .is_some_and(|registered| Arc::ptr_eq(registered, &thread_current))
                    {
                        active.remove(&thread_root);
                    }
                }
                Err(_) => eprintln!("Lightwell could not clear its stopped workspace watcher."),
            }
        });

    if let Err(error) = spawn_result {
        active.remove(&root);
        return Err(format!(
            "Could not start the workspace file watcher: {error}"
        ));
    }

    let facts = current
        .read()
        .map_err(|_| "The workspace map cache is unavailable.".to_owned())?
        .clone();
    Ok(workspace_map_document(&root, facts))
}

/// Keeps the cached map current and hands each changed map to `emit` until the
/// watcher stops, the cache is unusable, or `emit` returns `false`.
fn forward_map_changes(
    watcher: &mut MapWatcher,
    current: &RwLock<FactMap>,
    root: &Path,
    mut emit: impl FnMut(WorkspaceMapUpdate) -> bool,
) {
    loop {
        match watcher.next_changed_map() {
            Ok(facts) => {
                match current.write() {
                    Ok(mut cached) => *cached = facts.clone(),
                    Err(_) => {
                        eprintln!("Lightwell could not update the cached workspace map.");
                        break;
                    }
                }
                let update = WorkspaceMapUpdate {
                    workspace_id: root.to_string_lossy().into_owned(),
                    document: workspace_map_document(root, facts),
                };
                if !emit(update) {
                    break;
                }
            }
            Err(error @ MapWatchError::Extraction(_)) => {
                eprintln!("Lightwell could not refresh the workspace map: {error}");
            }
            Err(error) => {
                eprintln!("Lightwell stopped watching the workspace: {error}");
                break;
            }
        }
    }
}

fn workspace_root(path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path);
    let root = requested.canonicalize().map_err(|error| {
        format!(
            "Could not open workspace folder {}: {error}",
            requested.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!("{} is not a workspace folder.", root.display()));
    }
    if lightwell_core::project_manifest(&root).is_none() {
        return Err(format!(
            "No Cargo.toml, package.json, tsconfig.json, or jsconfig.json was found in {}. Choose a project folder.",
            root.display()
        ));
    }
    Ok(root)
}

fn empty_annotations(facts: &FactMap) -> Value {
    json!({
        "schemaVersion": 1,
        "projectId": &facts.project.id,
        "blocks": {},
        "features": [],
        "groups": [],
    })
}

fn workspace_map_document(root: &Path, facts: FactMap) -> WorkspaceMapDocument {
    let annotations = empty_annotations(&facts);
    let project_notes = match project_notes_for_map(root, &facts) {
        Ok(notes) => ProjectNotesState::Ready { notes },
        Err(error) => ProjectNotesState::Error {
            message: error.to_string(),
        },
    };
    WorkspaceMapDocument {
        facts,
        annotations,
        project_notes,
    }
}

fn recent_workspaces_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("recent-workspaces.json"))
        .map_err(|error| format!("Could not locate Lightwell's user config folder: {error}"))
}

fn editor_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("editor-settings.json"))
        .map_err(|error| format!("Could not locate Lightwell's user config folder: {error}"))
}

fn normalize_editor_settings(mut settings: EditorSettings) -> Result<EditorSettings, String> {
    if let Some(template) = settings.command_template.take() {
        let trimmed = template.trim();
        if trimmed.len() > MAX_EDITOR_TEMPLATE_LENGTH {
            return Err(format!(
                "Editor command templates must be {MAX_EDITOR_TEMPLATE_LENGTH} characters or shorter."
            ));
        }
        if trimmed.chars().any(char::is_control) {
            return Err("Editor command templates cannot contain control characters.".to_owned());
        }
        settings.command_template = (!trimmed.is_empty()).then(|| trimmed.to_owned());
    }
    Ok(settings)
}

fn read_editor_settings(path: &Path) -> Result<EditorSettings, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(EditorSettings::default())
        }
        Err(error) => {
            return Err(format!(
                "Could not read editor settings from {}: {error}",
                path.display()
            ))
        }
    };
    let settings: EditorSettings = serde_json::from_slice(&contents).map_err(|error| {
        format!(
            "Could not parse editor settings in {}: {error}",
            path.display()
        )
    })?;
    normalize_editor_settings(settings)
}

fn write_editor_settings(path: &Path, settings: &EditorSettings) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "The Lightwell user config folder has no parent.".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "Could not create Lightwell's user config folder {}: {error}",
            directory.display()
        )
    })?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not serialize editor settings: {error}"))?;
    fs::write(&temporary, contents).map_err(|error| {
        format!(
            "Could not write editor settings to {}: {error}",
            temporary.display()
        )
    })?;
    fs::rename(&temporary, path).map_err(|error| {
        format!(
            "Could not save editor settings to {}: {error}",
            path.display()
        )
    })
}

fn remember_workspace(app: &AppHandle, root: &Path, facts: &FactMap) -> Result<(), String> {
    let entry = WorkspaceEntry {
        id: root.to_string_lossy().into_owned(),
        label: facts.project.name.clone(),
    };
    let config_path = recent_workspaces_path(app)?;
    let mut recent = read_recent_workspaces(&config_path)?;
    recent.retain(|item| item.id != entry.id);
    recent.insert(0, entry);
    recent.truncate(MAX_RECENT_WORKSPACES);
    write_recent_workspaces(&config_path, &recent)
}

fn read_recent_workspaces(path: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read recent workspaces from {}: {error}",
                path.display()
            ))
        }
    };
    serde_json::from_slice(&contents).map_err(|error| {
        format!(
            "Could not parse recent workspaces in {}: {error}",
            path.display()
        )
    })
}

fn write_recent_workspaces(path: &Path, workspaces: &[WorkspaceEntry]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "The Lightwell user config folder has no parent.".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "Could not create Lightwell's user config folder {}: {error}",
            directory.display()
        )
    })?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(workspaces)
        .map_err(|error| format!("Could not serialize recent workspaces: {error}"))?;
    fs::write(&temporary, contents).map_err(|error| {
        format!(
            "Could not write recent workspaces to {}: {error}",
            temporary.display()
        )
    })?;
    fs::rename(&temporary, path).map_err(|error| {
        format!(
            "Could not save recent workspaces to {}: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{
        forward_map_changes, normalize_editor_settings, read_editor_settings,
        read_recent_workspaces, workspace_root, write_editor_settings, write_recent_workspaces,
        WorkspaceEntry,
    };
    use lightwell_core::{extract_cargo_map, EditorSettings, MapWatcher};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::RwLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("lightwell-{label}-{}-{unique}", std::process::id()))
    }

    #[test]
    fn non_rust_folder_has_an_actionable_error() {
        let root = temporary_directory("not-rust");
        fs::create_dir_all(&root).expect("temporary folder should be created");
        let error = workspace_root(root.to_str().expect("temporary path should be UTF-8"))
            .expect_err("folder without a project manifest should be rejected");
        assert!(error.contains("Cargo.toml"));
        assert!(error.contains("package.json"));
        assert!(error.contains("project folder"));
        fs::remove_dir_all(root).expect("temporary folder should be removed");
    }

    #[test]
    fn node_project_folder_is_a_workspace_without_cargo_toml() {
        let root = temporary_directory("node-app");
        fs::create_dir_all(&root).expect("temporary folder should be created");
        fs::write(root.join("package.json"), "{\n  \"name\": \"demo\"\n}\n")
            .expect("package.json should be written");
        fs::write(
            root.join("tsconfig.json"),
            "{\n  \"compilerOptions\": {}\n}\n",
        )
        .expect("tsconfig.json should be written");
        let opened = workspace_root(root.to_str().expect("temporary path should be UTF-8"))
            .expect("a Node project should open");
        assert_eq!(opened, root.canonicalize().expect("root should resolve"));
        fs::remove_dir_all(root).expect("temporary folder should be removed");
    }

    #[test]
    fn recent_workspaces_round_trip_through_user_config_json() {
        let config = temporary_directory("recent").join("recent-workspaces.json");
        let expected = vec![WorkspaceEntry {
            id: "/projects/lightwell".to_owned(),
            label: "Lightwell".to_owned(),
        }];
        write_recent_workspaces(&config, &expected).expect("recent workspaces should save");
        assert_eq!(
            read_recent_workspaces(&config).expect("recent workspaces should load"),
            expected
        );
        fs::remove_dir_all(config.parent().expect("config path should have a parent"))
            .expect("temporary config folder should be removed");
    }

    #[test]
    fn editor_settings_default_and_round_trip_in_user_config_json() {
        let config = temporary_directory("editor-settings").join("editor-settings.json");
        assert_eq!(
            read_editor_settings(&config).expect("missing editor settings should default"),
            EditorSettings::default()
        );
        let expected = EditorSettings {
            command_template: Some("zed {file}:{line}:{column}".to_owned()),
        };
        write_editor_settings(&config, &expected).expect("editor settings should save");
        assert_eq!(
            read_editor_settings(&config).expect("editor settings should load"),
            expected
        );
        std::fs::remove_dir_all(config.parent().expect("config path should have a parent"))
            .expect("temporary config folder should be removed");
    }

    #[test]
    fn editor_settings_trim_empty_templates_and_reject_invalid_input() {
        assert_eq!(
            normalize_editor_settings(EditorSettings {
                command_template: Some("  ".to_owned()),
            })
            .expect("blank template should select the OS default"),
            EditorSettings::default()
        );
        assert!(normalize_editor_settings(EditorSettings {
            command_template: Some("editor\n{file}".to_owned()),
        })
        .is_err());
    }

    #[test]
    fn forwarded_changes_update_the_cache_and_carry_the_workspace_id() {
        let root = temporary_directory("forward-changes");
        fs::create_dir_all(root.join("src")).expect("fixture source folder should be created");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"forward-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("fixture manifest should be written");
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n")
            .expect("fixture library should be written");
        let root = root.canonicalize().expect("fixture root should resolve");

        let mut watcher = MapWatcher::new(&root, None).expect("watcher should start");
        let initial = extract_cargo_map(&root, None).expect("fixture map should extract");
        let cache = RwLock::new(initial.clone());
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 2 }\n")
            .expect("fixture library should be edited");

        let mut updates = Vec::new();
        forward_map_changes(&mut watcher, &cache, &root, |update| {
            updates.push(update);
            false
        });

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].workspace_id, root.to_string_lossy());
        let cached = cache.read().expect("cache should be readable");
        assert_ne!(
            serde_json::to_value(&*cached).unwrap(),
            serde_json::to_value(&initial).unwrap(),
            "the cached map should reflect the edit"
        );
        assert_eq!(
            serde_json::to_value(&updates[0].document.facts).unwrap(),
            serde_json::to_value(&*cached).unwrap(),
        );
        drop(cached);
        fs::remove_dir_all(root).expect("temporary folder should be removed");
    }
}
