use lightwell_core::{extract_cargo_map, FactMap, MapWatchError, MapWatcher};
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMapUpdate {
    workspace_id: String,
    document: WorkspaceMapDocument,
}

#[derive(Clone, Default)]
pub struct WorkspaceWatchers(Arc<Mutex<HashMap<PathBuf, Arc<RwLock<FactMap>>>>>);

#[tauri::command]
pub fn recent_workspaces(app: AppHandle) -> Result<Vec<WorkspaceEntry>, String> {
    read_recent_workspaces(&recent_workspaces_path(&app)?)
}

#[tauri::command]
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

#[tauri::command]
pub fn load_workspace_map(app: AppHandle, path: String) -> Result<WorkspaceMapDocument, String> {
    let root = workspace_root(&path)?;
    let facts = extract_cargo_map(&root, None).map_err(|error| error.to_string())?;
    remember_workspace(&app, &root, &facts)?;
    Ok(workspace_map_document(facts))
}

#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    watchers: State<'_, WorkspaceWatchers>,
    path: String,
) -> Result<WorkspaceMapDocument, String> {
    let root = workspace_root(&path)?;
    start_workspace_watcher(&app, watchers.inner(), root)
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
        return Ok(workspace_map_document(facts));
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
            loop {
                match watcher.next_changed_map() {
                    Ok(facts) => {
                        match thread_current.write() {
                            Ok(mut current) => *current = facts.clone(),
                            Err(_) => {
                                eprintln!("Lightwell could not update the cached workspace map.");
                                break;
                            }
                        }
                        let update = WorkspaceMapUpdate {
                            workspace_id: thread_root.to_string_lossy().into_owned(),
                            document: workspace_map_document(facts),
                        };
                        if let Err(error) = thread_app.emit("workspace-map-changed", update) {
                            eprintln!("Lightwell could not send a workspace map update: {error}");
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
    Ok(workspace_map_document(facts))
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
    if !root.join("Cargo.toml").is_file() {
        return Err(format!(
            "No Cargo.toml was found in {}. Choose a Rust workspace folder.",
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

fn workspace_map_document(facts: FactMap) -> WorkspaceMapDocument {
    let annotations = empty_annotations(&facts);
    WorkspaceMapDocument { facts, annotations }
}

fn recent_workspaces_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("recent-workspaces.json"))
        .map_err(|error| format!("Could not locate Lightwell's user config folder: {error}"))
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
    use super::{read_recent_workspaces, workspace_root, write_recent_workspaces, WorkspaceEntry};
    use std::fs;
    use std::path::PathBuf;
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
            .expect_err("folder without Cargo.toml should be rejected");
        assert!(error.contains("Cargo.toml"));
        assert!(error.contains("Rust workspace folder"));
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
}
