mod git;
pub use git::{
    commit_project_note, project_note_git_status, NoteCommitResult, NotesGitFileState,
    NotesGitStatus,
};

use crate::extract::{block_base, discover_project_workspace, map_workspace};
use crate::{FactMap, MapExtractionError};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const NOTES_SCHEMA_VERSION: u32 = 1;
/// Fallback when Git user.name/email cannot be resolved from the project repository.
pub const DEFAULT_NOTE_AUTHOR: &str = "unknown";
/// Empty `updatedAt` means unknown/legacy (note written before this field existed).
pub const DEFAULT_NOTE_UPDATED_AT: &str = "";
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

fn default_note_author() -> String {
    DEFAULT_NOTE_AUTHOR.to_owned()
}

fn default_note_updated_at() -> String {
    DEFAULT_NOTE_UPDATED_AT.to_owned()
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNoteView {
    pub block_id: String,
    pub text: String,
    pub source_fingerprint: String,
    pub author: String,
    pub updated_at: String,
    pub stale: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectNote {
    text: String,
    source_fingerprint: String,
    #[serde(default = "default_note_author")]
    author: String,
    #[serde(default = "default_note_updated_at")]
    updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesDocument {
    schema_version: u32,
    notes: BTreeMap<String, ProjectNote>,
}

impl Default for NotesDocument {
    fn default() -> Self {
        Self {
            schema_version: NOTES_SCHEMA_VERSION,
            notes: BTreeMap::new(),
        }
    }
}

struct ProjectNotesStore {
    path: PathBuf,
}

impl ProjectNotesStore {
    fn new(project_root: &Path) -> Self {
        Self {
            path: project_root.join(".lightwell").join("notes.json"),
        }
    }

    fn list_for_map(&self, map: &FactMap) -> Result<Vec<ProjectNoteView>, NotesError> {
        let document = self.read_document()?;
        let current_fingerprints: BTreeMap<_, _> = map
            .blocks
            .iter()
            .map(|block| {
                let base = block_base(block);
                (base.id.as_str(), base.fingerprint.as_str())
            })
            .collect();

        Ok(document
            .notes
            .into_iter()
            .map(|(block_id, note)| ProjectNoteView {
                stale: current_fingerprints
                    .get(block_id.as_str())
                    .is_none_or(|fingerprint| *fingerprint != note.source_fingerprint.as_str()),
                block_id,
                text: note.text,
                source_fingerprint: note.source_fingerprint,
                author: note.author,
                updated_at: note.updated_at,
            })
            .collect())
    }

    #[cfg(test)]
    fn set(
        &self,
        project_root: &Path,
        block_id: &str,
        text: &str,
        source_fingerprint: &str,
    ) -> Result<(), NotesError> {
        self.set_with_replace(project_root, block_id, text, source_fingerprint, true)
    }

    fn set_if_absent(
        &self,
        project_root: &Path,
        block_id: &str,
        text: &str,
        source_fingerprint: &str,
    ) -> Result<(), NotesError> {
        self.set_with_replace(project_root, block_id, text, source_fingerprint, false)
    }

    fn set_with_replace(
        &self,
        project_root: &Path,
        block_id: &str,
        text: &str,
        source_fingerprint: &str,
        replace_existing: bool,
    ) -> Result<(), NotesError> {
        if text.trim().is_empty() {
            return Err(NotesError::EmptyText);
        }
        let author = resolve_note_author(project_root);
        let updated_at = utc_now_rfc3339();
        self.update(true, |document| {
            if document.notes.contains_key(block_id) && !replace_existing {
                return Err(NotesError::NoteAlreadyExists(block_id.to_owned()));
            }
            document.notes.insert(
                block_id.to_owned(),
                ProjectNote {
                    text: text.to_owned(),
                    source_fingerprint: source_fingerprint.to_owned(),
                    author,
                    updated_at,
                },
            );
            Ok(true)
        })
        .map(|_| ())
    }

    fn update_text(
        &self,
        project_root: &Path,
        block_id: &str,
        text: &str,
    ) -> Result<(), NotesError> {
        if text.trim().is_empty() {
            return Err(NotesError::EmptyText);
        }
        let author = resolve_note_author(project_root);
        let updated_at = utc_now_rfc3339();
        let updated = self.update(false, |document| {
            let note = document
                .notes
                .get_mut(block_id)
                .ok_or_else(|| NotesError::NoteNotFound(block_id.to_owned()))?;
            note.text = text.to_owned();
            note.author = author;
            note.updated_at = updated_at;
            Ok(true)
        })?;
        if !updated {
            return Err(NotesError::NoteNotFound(block_id.to_owned()));
        }
        Ok(())
    }

    fn remove(&self, block_id: &str) -> Result<bool, NotesError> {
        if !self.path.is_file() {
            return Ok(false);
        }
        self.update(false, |document| {
            Ok(document.notes.remove(block_id).is_some())
        })
    }

    fn refresh_fingerprint(
        &self,
        block_id: &str,
        source_fingerprint: &str,
    ) -> Result<(), NotesError> {
        let updated = self.update(false, |document| {
            let note = document
                .notes
                .get_mut(block_id)
                .ok_or_else(|| NotesError::NoteNotFound(block_id.to_owned()))?;
            note.source_fingerprint = source_fingerprint.to_owned();
            Ok(true)
        })?;
        if !updated {
            return Err(NotesError::NoteNotFound(block_id.to_owned()));
        }
        Ok(())
    }

    fn remove_stale_for_map(&self, map: &FactMap) -> Result<usize, NotesError> {
        if !self.path.is_file() {
            return Ok(0);
        }
        let current_fingerprints: BTreeMap<_, _> = map
            .blocks
            .iter()
            .map(|block| {
                let base = block_base(block);
                (base.id.clone(), base.fingerprint.clone())
            })
            .collect();
        let mut removed = 0usize;
        self.update(false, |document| {
            let before = document.notes.len();
            document.notes.retain(|block_id, note| {
                current_fingerprints
                    .get(block_id)
                    .is_some_and(|fingerprint| fingerprint == &note.source_fingerprint)
            });
            removed = before - document.notes.len();
            Ok(removed > 0)
        })?;
        Ok(removed)
    }

    fn update(
        &self,
        create_parent: bool,
        update_document: impl FnOnce(&mut NotesDocument) -> Result<bool, NotesError>,
    ) -> Result<bool, NotesError> {
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        if create_parent {
            fs::create_dir_all(parent).map_err(|source| NotesError::Io {
                path: parent.to_owned(),
                source,
            })?;
        } else if !parent.is_dir() {
            return Ok(false);
        }

        let lock_path = parent.join("notes.lock");
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|source| NotesError::Io {
                path: lock_path,
                source,
            })?;
        lock_file
            .lock_exclusive()
            .map_err(|source| NotesError::Io {
                path: parent.join("notes.lock"),
                source,
            })?;
        let _lock = ExclusiveLock(lock_file);

        Self::ensure_artifact_ignores(parent)?;

        let mut document = self.read_document()?;
        let changed = update_document(&mut document)?;
        if changed {
            self.write_document(&document)?;
        }
        Ok(changed)
    }

    fn ensure_artifact_ignores(parent: &Path) -> Result<(), NotesError> {
        let path = parent.join(".gitignore");
        let result = (|| -> io::Result<()> {
            let contents = match fs::read(&path) {
                Ok(contents) => contents,
                Err(source) if source.kind() == io::ErrorKind::NotFound => Vec::new(),
                Err(source) => return Err(source),
            };
            let rules = b"notes.lock\n*.tmp\n";
            if contents == rules || contents.ends_with(b"\nnotes.lock\n*.tmp\n") {
                return Ok(());
            }

            let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
            if !contents.is_empty() && !contents.ends_with(b"\n") {
                file.write_all(b"\n")?;
            }
            file.write_all(rules)
        })();
        result.map_err(|source| NotesError::Io { path, source })
    }

    fn read_document(&self) -> Result<NotesDocument, NotesError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                return Ok(NotesDocument::default());
            }
            Err(source) => {
                return Err(NotesError::Io {
                    path: self.path.clone(),
                    source,
                });
            }
        };
        let document: NotesDocument =
            serde_json::from_slice(&bytes).map_err(|source| NotesError::InvalidJson {
                path: self.path.clone(),
                source,
            })?;
        if document.schema_version != NOTES_SCHEMA_VERSION {
            return Err(NotesError::UnsupportedSchema {
                path: self.path.clone(),
                version: document.schema_version,
            });
        }
        Ok(document)
    }

    fn write_document(&self, document: &NotesDocument) -> Result<(), NotesError> {
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        let mut contents = serde_json::to_vec_pretty(document).map_err(NotesError::Serialize)?;
        contents.push(b'\n');

        let (temporary_path, mut temporary_file) = loop {
            let sequence = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let temporary_path =
                parent.join(format!(".notes-{}-{sequence}.tmp", std::process::id()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
            {
                Ok(file) => break (temporary_path, file),
                Err(source) if source.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(source) => {
                    return Err(NotesError::Io {
                        path: temporary_path,
                        source,
                    });
                }
            }
        };

        let result = (|| {
            temporary_file
                .write_all(&contents)
                .and_then(|()| temporary_file.sync_all())
                .map_err(|source| NotesError::Io {
                    path: temporary_path.clone(),
                    source,
                })?;
            drop(temporary_file);
            fs::rename(&temporary_path, &self.path).map_err(|source| NotesError::Io {
                path: self.path.clone(),
                source,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

struct ExclusiveLock(File);

impl Drop for ExclusiveLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub fn list_project_notes(
    repository_path: impl AsRef<Path>,
) -> Result<Vec<ProjectNoteView>, NotesError> {
    let (root, map) = workspace_map(repository_path)?;
    ProjectNotesStore::new(&root).list_for_map(&map)
}

pub fn project_notes_for_map(
    project_root: impl AsRef<Path>,
    map: &FactMap,
) -> Result<Vec<ProjectNoteView>, NotesError> {
    ProjectNotesStore::new(project_root.as_ref()).list_for_map(map)
}

pub fn set_project_note(
    repository_path: impl AsRef<Path>,
    block_id: &str,
    text: &str,
) -> Result<ProjectNoteView, NotesError> {
    let (root, map) = workspace_map(repository_path)?;
    let notes = set_project_note_for_map(&root, &map, block_id, text)?;
    notes
        .into_iter()
        .find(|note| note.block_id == block_id)
        .ok_or_else(|| NotesError::NoteNotFound(block_id.to_owned()))
}

pub fn set_project_note_if_absent(
    repository_path: impl AsRef<Path>,
    block_id: &str,
    text: &str,
) -> Result<ProjectNoteView, NotesError> {
    let (root, map) = workspace_map(repository_path)?;
    let notes = set_project_note_for_map_if_absent(&root, &map, block_id, text)?;
    notes
        .into_iter()
        .find(|note| note.block_id == block_id)
        .ok_or_else(|| NotesError::NoteNotFound(block_id.to_owned()))
}

pub fn set_project_note_for_map(
    project_root: impl AsRef<Path>,
    map: &FactMap,
    block_id: &str,
    text: &str,
) -> Result<Vec<ProjectNoteView>, NotesError> {
    let block = map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id)
        .ok_or_else(|| NotesError::BlockNotFound(block_id.to_owned()))?;
    let fingerprint = &block_base(block).fingerprint;
    let root = project_root.as_ref();
    let store = ProjectNotesStore::new(root);
    store.set_with_replace(root, block_id, text, fingerprint, true)?;
    store.list_for_map(map)
}

fn set_project_note_for_map_if_absent(
    project_root: impl AsRef<Path>,
    map: &FactMap,
    block_id: &str,
    text: &str,
) -> Result<Vec<ProjectNoteView>, NotesError> {
    let block = map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id)
        .ok_or_else(|| NotesError::BlockNotFound(block_id.to_owned()))?;
    let fingerprint = &block_base(block).fingerprint;
    let root = project_root.as_ref();
    let store = ProjectNotesStore::new(root);
    store.set_if_absent(root, block_id, text, fingerprint)?;
    store.list_for_map(map)
}

pub fn update_project_note_text(
    project_root: impl AsRef<Path>,
    map: &FactMap,
    block_id: &str,
    text: &str,
) -> Result<Vec<ProjectNoteView>, NotesError> {
    let root = project_root.as_ref();
    let store = ProjectNotesStore::new(root);
    store.update_text(root, block_id, text)?;
    store.list_for_map(map)
}

pub fn remove_project_note(
    repository_path: impl AsRef<Path>,
    block_id: &str,
) -> Result<bool, NotesError> {
    let workspace = discover_project_workspace(repository_path)?;
    ProjectNotesStore::new(&workspace.root).remove(block_id)
}

/// Update a note's stored fingerprint to the block's current fingerprint.
///
/// Use this when the note text still matches the source after a code change.
/// Orphaned notes (block missing from the map) cannot be marked reviewed.
pub fn mark_project_note_reviewed(
    project_root: impl AsRef<Path>,
    map: &FactMap,
    block_id: &str,
) -> Result<Vec<ProjectNoteView>, NotesError> {
    let block = map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id)
        .ok_or_else(|| NotesError::BlockNotFound(block_id.to_owned()))?;
    let fingerprint = &block_base(block).fingerprint;
    let store = ProjectNotesStore::new(project_root.as_ref());
    store.refresh_fingerprint(block_id, fingerprint)?;
    store.list_for_map(map)
}

/// Remove every note that is stale relative to `map`. Current notes are kept.
pub fn remove_stale_project_notes(
    project_root: impl AsRef<Path>,
    map: &FactMap,
) -> Result<(usize, Vec<ProjectNoteView>), NotesError> {
    let store = ProjectNotesStore::new(project_root.as_ref());
    let removed = store.remove_stale_for_map(map)?;
    let notes = store.list_for_map(map)?;
    Ok((removed, notes))
}

fn workspace_map(repository_path: impl AsRef<Path>) -> Result<(PathBuf, FactMap), NotesError> {
    let workspace = discover_project_workspace(repository_path)?;
    let root = workspace.root.clone();
    let map = map_workspace(workspace, None)?;
    Ok((root, map))
}

fn resolve_note_author(project_root: &Path) -> String {
    // Deliberate provenance: only the project's Git identity, via the same
    // `git` CLI path notes already use for commits — not libgit2 and not an
    // invented OS username. Outside a work tree, do not read global config.
    if !git_is_inside_work_tree(project_root) {
        return DEFAULT_NOTE_AUTHOR.to_owned();
    }
    let name = git_config_value(project_root, "user.name");
    let email = git_config_value(project_root, "user.email");
    match (name.as_deref(), email.as_deref()) {
        (None, None) => DEFAULT_NOTE_AUTHOR.to_owned(),
        (Some(name), None) => name.to_owned(),
        (None, Some(email)) => format!("<{email}>"),
        (Some(name), Some(email)) => format!("{name} <{email}>"),
    }
}

fn git_is_inside_work_tree(project_root: &Path) -> bool {
    let Ok(output) = std::process::Command::new("git")
        .args(["-C"])
        .arg(project_root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
    else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
}

fn git_config_value(project_root: &Path, key: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-C"])
        .arg(project_root)
        .args(["config", "--get", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn utc_now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format_unix_secs_rfc3339(secs)
}

/// Format a Unix timestamp as `YYYY-MM-DDTHH:MM:SSZ` (UTC, whole seconds).
fn format_unix_secs_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let time_of_day = secs % 86_400;
    let hour = time_of_day / 3_600;
    let minute = (time_of_day % 3_600) / 60;
    let second = time_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since Unix epoch → Gregorian (year, month, day). Howard Hinnant algorithm.
fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[derive(Debug)]
pub enum NotesError {
    Extraction(MapExtractionError),
    BlockNotFound(String),
    NoteNotFound(String),
    NoteAlreadyExists(String),
    EmptyText,
    Io {
        path: PathBuf,
        source: io::Error,
    },
    InvalidJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    UnsupportedSchema {
        path: PathBuf,
        version: u32,
    },
    Serialize(serde_json::Error),
}

impl Display for NotesError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Extraction(source) => Display::fmt(source, formatter),
            Self::BlockNotFound(id) => write!(
                formatter,
                "No block with ID `{id}` exists in this workspace. Run `lightwell extract . -o /tmp/lightwell-map.json` here and choose a `blocks[].id` value."
            ),
            Self::NoteNotFound(id) => write!(formatter, "No saved note exists for block `{id}`."),
            Self::NoteAlreadyExists(id) => write!(
                formatter,
                "A note already exists for block `{id}`. Use `lightwell notes set --replace {id} <text...>` to overwrite it."
            ),
            Self::EmptyText => write!(
                formatter,
                "Note text cannot be empty. Use `lightwell notes set <block-id> <text...>`."
            ),
            Self::Io { path, source } => write!(
                formatter,
                "Could not read or update project notes at {}: {source}",
                path.display()
            ),
            Self::InvalidJson { path, source } => write!(
                formatter,
                "Could not parse project notes at {}: {source}",
                path.display()
            ),
            Self::UnsupportedSchema { path, version } => write!(
                formatter,
                "Project notes at {} use unsupported schema version {version}.",
                path.display()
            ),
            Self::Serialize(source) => write!(formatter, "Could not encode project notes: {source}"),
        }
    }
}

impl Error for NotesError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Extraction(source) => Some(source),
            Self::Io { source, .. } => Some(source),
            Self::InvalidJson { source, .. } | Self::Serialize(source) => Some(source),
            Self::BlockNotFound(_)
            | Self::NoteNotFound(_)
            | Self::NoteAlreadyExists(_)
            | Self::EmptyText
            | Self::UnsupportedSchema { .. } => None,
        }
    }
}

impl From<MapExtractionError> for NotesError {
    fn from(source: MapExtractionError) -> Self {
        Self::Extraction(source)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        list_project_notes, mark_project_note_reviewed, remove_project_note,
        remove_stale_project_notes, set_project_note, set_project_note_for_map,
        update_project_note_text, NotesError, ProjectNotesStore,
    };
    use crate::extract::{block_base, extract_cargo_map};
    use crate::facts::{BlockBase, CrateBlock, FactBlock, FactGroup, FactMap, MapStats, Project};
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TempProject(PathBuf);

    impl TempProject {
        fn new() -> Self {
            let sequence = NEXT_TEMP_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "lightwell-notes-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn map(fingerprint: &str) -> FactMap {
        let block = FactBlock::Crate(CrateBlock {
            base: BlockBase {
                id: "crate:core".to_owned(),
                label: "core".to_owned(),
                parent_id: Some("workspace:test".to_owned()),
                children: Vec::new(),
                source_path: Some("Cargo.toml".to_owned()),
                fingerprint: fingerprint.to_owned(),
            },
            package_name: "core".to_owned(),
            version: "0.1.0".to_owned(),
            description: None,
        });
        FactMap::schema_v1(
            Project {
                id: "workspace:test".to_owned(),
                name: "test".to_owned(),
                root_path: ".".to_owned(),
            },
            vec![block],
            Vec::new(),
            vec![FactGroup {
                id: "group:crates".to_owned(),
                label: "Workspace crates".to_owned(),
                member_ids: vec!["crate:core".to_owned()],
            }],
            MapStats {
                blocks: 1,
                crates: 1,
                ..MapStats::default()
            },
        )
    }

    #[test]
    fn first_save_creates_notes_and_changed_fingerprints_mark_without_deleting() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        let old_map = map("old-fingerprint");
        let new_map = map("new-fingerprint");

        assert!(store.list_for_map(&old_map).unwrap().is_empty());
        assert!(!project.0.join(".lightwell").exists());
        store
            .set(
                &project.0,
                "crate:core",
                "Remember this crate",
                "old-fingerprint",
            )
            .unwrap();

        let notes_path = project.0.join(".lightwell/notes.json");
        assert!(notes_path.is_file());
        let stale = store.list_for_map(&new_map).unwrap();
        assert_eq!(stale.len(), 1);
        assert!(stale[0].stale);
        assert_eq!(stale[0].text, "Remember this crate");
        assert_eq!(stale[0].source_fingerprint, "old-fingerprint");
        assert!(!store.list_for_map(&old_map).unwrap()[0].stale);
        assert!(notes_path.is_file());
    }

    #[test]
    fn setting_an_existing_note_requires_explicit_replacement() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        store
            .set(&project.0, "crate:core", "Keep this", "old")
            .unwrap();

        assert!(matches!(
            store.set_with_replace(&project.0, "crate:core", "Do not replace", "new", false),
            Err(NotesError::NoteAlreadyExists(block_id)) if block_id == "crate:core"
        ));
        let saved = store.list_for_map(&map("old")).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].text, "Keep this");
        assert_eq!(saved[0].source_fingerprint, "old");

        store
            .set_with_replace(&project.0, "crate:core", "Replace this", "new", true)
            .unwrap();
        let replaced = store.list_for_map(&map("new")).unwrap();
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].text, "Replace this");
        assert_eq!(replaced[0].source_fingerprint, "new");
    }

    #[test]
    fn saves_ignore_lock_and_temp_files_without_hiding_or_staging_notes() {
        for existing_rules in [
            None,
            Some("user-cache/\n"),
            Some("notes.lock\r\n!notes.lock\r\n!*.tmp"),
            Some("#notes.lock\n*.tmp\n"),
        ] {
            let project = TempProject::new();
            let git = |args: &[&str]| {
                let output = Command::new("git")
                    .current_dir(&project.0)
                    .args(["-c", "core.excludesFile="])
                    .args(args)
                    .output()
                    .expect("Git should run for the temporary repository");
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout)
                    .unwrap()
                    .replace("\r\n", "\n")
            };
            git(&["init", "-q"]);
            fs::write(project.0.join(".gitignore"), "user-cache/\n").unwrap();
            let ignore_path = project.0.join(".lightwell/.gitignore");
            if let Some(rules) = existing_rules {
                fs::create_dir(project.0.join(".lightwell")).unwrap();
                fs::write(&ignore_path, rules).unwrap();
            }

            let current_map = map("fingerprint");
            let notes = set_project_note_for_map(
                &project.0,
                &current_map,
                "crate:core",
                "Remember this crate",
            )
            .unwrap();
            assert_eq!(notes[0].text, "Remember this crate");
            let first_rules = fs::read(&ignore_path).unwrap();
            if let Some(rules) = existing_rules {
                assert!(
                    first_rules.starts_with(rules.as_bytes()),
                    "User rules must survive byte for byte"
                );
            }
            let notes =
                set_project_note_for_map(&project.0, &current_map, "crate:core", "Updated note")
                    .unwrap();
            assert_eq!(notes[0].text, "Updated note");
            assert_eq!(fs::read(&ignore_path).unwrap(), first_rules);
            assert_eq!(
                fs::read_to_string(project.0.join(".gitignore")).unwrap(),
                "user-cache/\n"
            );

            fs::write(
                project.0.join(".lightwell/.notes-123-0.tmp"),
                "interrupted save",
            )
            .unwrap();
            fs::write(project.0.join(".lightwell/leftover.tmp"), "temporary data").unwrap();
            assert_eq!(
                git(&[
                    "check-ignore",
                    ".lightwell/notes.lock",
                    ".lightwell/.notes-123-0.tmp",
                    ".lightwell/leftover.tmp"
                ]),
                ".lightwell/notes.lock\n.lightwell/.notes-123-0.tmp\n.lightwell/leftover.tmp\n"
            );
            assert_eq!(
                git(&["status", "--porcelain", "--untracked-files=all"]),
                "?? .gitignore\n?? .lightwell/.gitignore\n?? .lightwell/notes.json\n"
            );
            assert_eq!(git(&["ls-files", "--stage"]), "");
        }
    }

    #[test]
    fn removing_a_note_is_explicit_and_does_not_remove_other_notes() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        store.set(&project.0, "crate:core", "First", "one").unwrap();
        store
            .set(&project.0, "module:core:api", "Second", "two")
            .unwrap();

        assert!(store.remove("crate:core").unwrap());
        assert!(!store.remove("crate:core").unwrap());
        let notes = store.list_for_map(&map("two")).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].block_id, "module:core:api");
    }

    #[test]
    fn concurrent_saves_keep_both_notes() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        let left = ProjectNotesStore::new(&project.0);
        let right = ProjectNotesStore::new(&project.0);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                left.set(&project.0, "crate:left", "Left", "left-fingerprint")
                    .unwrap()
            });
            scope.spawn(|| {
                right
                    .set(&project.0, "crate:right", "Right", "right-fingerprint")
                    .unwrap()
            });
        });

        let notes = store
            .list_for_map(&FactMap::schema_v1(
                Project {
                    id: "workspace:test".to_owned(),
                    name: "test".to_owned(),
                    root_path: ".".to_owned(),
                },
                Vec::new(),
                Vec::new(),
                Vec::new(),
                MapStats::default(),
            ))
            .unwrap();
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|note| note.stale));
        assert_eq!(
            fs::read_to_string(project.0.join(".lightwell/.gitignore")).unwrap(),
            "notes.lock\n*.tmp\n"
        );
    }

    #[test]
    fn empty_note_text_is_rejected_without_creating_the_file() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        assert!(matches!(
            store.set(&project.0, "crate:core", "  ", "fingerprint"),
            Err(NotesError::EmptyText)
        ));
        assert!(!project.0.join(".lightwell").exists());
    }

    #[test]
    fn mark_reviewed_re_fingerprints_a_stale_note_without_changing_text() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        store
            .set(
                &project.0,
                "crate:core",
                "Still accurate",
                "old-fingerprint",
            )
            .unwrap();
        let current_map = map("new-fingerprint");
        let before = store.list_for_map(&current_map).unwrap();
        assert!(before[0].stale);

        let reviewed = mark_project_note_reviewed(&project.0, &current_map, "crate:core").unwrap();
        assert_eq!(reviewed.len(), 1);
        assert!(!reviewed[0].stale);
        assert_eq!(reviewed[0].text, "Still accurate");
        assert_eq!(reviewed[0].source_fingerprint, "new-fingerprint");
    }

    #[test]
    fn mark_reviewed_refuses_orphaned_notes_and_missing_notes() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        store
            .set(&project.0, "crate:gone", "Orphaned", "old-fingerprint")
            .unwrap();
        let empty_map = FactMap::schema_v1(
            Project {
                id: "workspace:test".to_owned(),
                name: "test".to_owned(),
                root_path: ".".to_owned(),
            },
            Vec::new(),
            Vec::new(),
            Vec::new(),
            MapStats::default(),
        );
        assert!(matches!(
            mark_project_note_reviewed(&project.0, &empty_map, "crate:gone"),
            Err(NotesError::BlockNotFound(_))
        ));
        assert!(matches!(
            mark_project_note_reviewed(&project.0, &map("fingerprint"), "crate:core"),
            Err(NotesError::NoteNotFound(_))
        ));
    }

    #[test]
    fn remove_stale_deletes_only_stale_notes_and_keeps_current() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        store
            .set(
                &project.0,
                "crate:core",
                "Current text",
                "current-fingerprint",
            )
            .unwrap();
        store
            .set(&project.0, "crate:old", "Stale text", "old-fingerprint")
            .unwrap();
        store
            .set(
                &project.0,
                "crate:gone",
                "Orphaned text",
                "gone-fingerprint",
            )
            .unwrap();
        let current_map = FactMap::schema_v1(
            Project {
                id: "workspace:test".to_owned(),
                name: "test".to_owned(),
                root_path: ".".to_owned(),
            },
            vec![
                FactBlock::Crate(CrateBlock {
                    base: BlockBase {
                        id: "crate:core".to_owned(),
                        label: "core".to_owned(),
                        parent_id: Some("workspace:test".to_owned()),
                        children: Vec::new(),
                        source_path: Some("Cargo.toml".to_owned()),
                        fingerprint: "current-fingerprint".to_owned(),
                    },
                    package_name: "core".to_owned(),
                    version: "0.1.0".to_owned(),
                    description: None,
                }),
                FactBlock::Crate(CrateBlock {
                    base: BlockBase {
                        id: "crate:old".to_owned(),
                        label: "old".to_owned(),
                        parent_id: Some("workspace:test".to_owned()),
                        children: Vec::new(),
                        source_path: Some("old/Cargo.toml".to_owned()),
                        fingerprint: "changed-fingerprint".to_owned(),
                    },
                    package_name: "old".to_owned(),
                    version: "0.1.0".to_owned(),
                    description: None,
                }),
            ],
            Vec::new(),
            Vec::new(),
            MapStats {
                blocks: 2,
                crates: 2,
                ..MapStats::default()
            },
        );

        let (removed, notes) = remove_stale_project_notes(&project.0, &current_map).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].block_id, "crate:core");
        assert!(!notes[0].stale);
        assert_eq!(notes[0].text, "Current text");

        let (again, notes) = remove_stale_project_notes(&project.0, &current_map).unwrap();
        assert_eq!(again, 0);
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn orphaned_note_text_can_be_edited_without_clearing_its_stale_fingerprint() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        let current_map = FactMap::schema_v1(
            Project {
                id: "workspace:test".to_owned(),
                name: "test".to_owned(),
                root_path: ".".to_owned(),
            },
            Vec::new(),
            Vec::new(),
            Vec::new(),
            MapStats::default(),
        );
        store
            .set(&project.0, "crate:core", "Original note", "old-fingerprint")
            .unwrap();

        let updated = update_project_note_text(
            &project.0,
            &current_map,
            "crate:core",
            "Edited after the crate was removed",
        )
        .unwrap();

        assert_eq!(updated.len(), 1);
        assert!(updated[0].stale);
        assert_eq!(updated[0].text, "Edited after the crate was removed");
        assert_eq!(updated[0].source_fingerprint, "old-fingerprint");
    }

    #[test]
    fn notes_can_be_added_and_removed_for_javascript_blocks_without_cargo_toml() {
        let project = TempProject::new();
        let root = &project.0;
        fs::create_dir_all(root.join("src")).expect("fixture source folder should be created");
        fs::write(
            root.join("package.json"),
            "{\n  \"name\": \"js-only\",\n  \"type\": \"module\"\n}\n",
        )
        .expect("package.json should be written");
        fs::write(
            root.join("src/app.mjs"),
            "export function greet() {\n  return \"hello\";\n}\n",
        )
        .expect("app.mjs should be written");
        fs::write(root.join("src/util.cjs"), "exports.answer = 42;\n")
            .expect("util.cjs should be written");
        fs::write(
            root.join("src/types.mts"),
            "export const answer: number = 42;\n",
        )
        .expect("types.mts should be written");

        let map = extract_cargo_map(root, None).expect("a Node project should extract");
        let block_id = map
            .blocks
            .iter()
            .find(|block| {
                block_base(block)
                    .source_path
                    .as_deref()
                    .is_some_and(|path| path.ends_with(".mjs"))
            })
            .map(|block| block_base(block).id.clone())
            .expect("the .mjs file should have a map block");

        set_project_note(root, &block_id, "Runs in the browser only")
            .expect("a note should save without a Cargo.toml");
        let notes = list_project_notes(root).expect("notes should list without a Cargo.toml");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].block_id, block_id);
        assert_eq!(notes[0].text, "Runs in the browser only");
        assert!(!notes[0].stale);

        assert!(remove_project_note(root, &block_id)
            .expect("a note should remove without a Cargo.toml"));
        assert!(list_project_notes(root)
            .expect("notes should list after removal")
            .is_empty());
    }

    #[test]
    fn new_note_records_git_author_when_user_is_configured() {
        let project = TempProject::new();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&project.0)
                .args(args)
                .output()
                .expect("Git should run for the temporary repository");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Notes Author"]);
        git(&["config", "user.email", "notes-author@example.invalid"]);

        let store = ProjectNotesStore::new(&project.0);
        store
            .set(&project.0, "crate:core", "With git author", "fingerprint")
            .unwrap();
        let notes = store.list_for_map(&map("fingerprint")).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            notes[0].author,
            "Notes Author <notes-author@example.invalid>"
        );
        assert_ne!(notes[0].author, super::DEFAULT_NOTE_AUTHOR);
        assert!(
            notes[0].updated_at.ends_with('Z') && notes[0].updated_at.len() == 20,
            "updatedAt should be RFC3339 UTC with seconds: {}",
            notes[0].updated_at
        );
    }

    #[test]
    fn author_is_unknown_outside_a_git_repo_or_without_user_config() {
        let project = TempProject::new();
        let store = ProjectNotesStore::new(&project.0);
        store
            .set(&project.0, "crate:core", "No git", "fingerprint")
            .unwrap();
        let notes = store.list_for_map(&map("fingerprint")).unwrap();
        assert_eq!(notes[0].author, super::DEFAULT_NOTE_AUTHOR);

        let git_project = TempProject::new();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&git_project.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        // Empty local identity overrides any global Git user so signature fails closed.
        git(&["config", "--local", "user.name", ""]);
        git(&["config", "--local", "user.email", ""]);
        let store = ProjectNotesStore::new(&git_project.0);
        store
            .set(
                &git_project.0,
                "crate:core",
                "Git without identity",
                "fingerprint",
            )
            .unwrap();
        let notes = store.list_for_map(&map("fingerprint")).unwrap();
        assert_eq!(notes[0].author, super::DEFAULT_NOTE_AUTHOR);
    }

    #[test]
    fn legacy_notes_json_without_author_or_updated_at_deserializes_defaults() {
        let project = TempProject::new();
        fs::create_dir(project.0.join(".lightwell")).unwrap();
        fs::write(
            project.0.join(".lightwell/notes.json"),
            r#"{
  "schemaVersion": 1,
  "notes": {
    "crate:core": {
      "text": "Legacy note",
      "sourceFingerprint": "legacy-fingerprint"
    }
  }
}
"#,
        )
        .unwrap();
        let store = ProjectNotesStore::new(&project.0);
        let notes = store.list_for_map(&map("legacy-fingerprint")).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].text, "Legacy note");
        assert_eq!(notes[0].author, super::DEFAULT_NOTE_AUTHOR);
        assert_eq!(notes[0].updated_at, super::DEFAULT_NOTE_UPDATED_AT);
        assert!(!notes[0].stale);
    }

    #[test]
    fn update_text_refreshes_updated_at_and_author() {
        let project = TempProject::new();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&project.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Updater"]);
        git(&["config", "user.email", "updater@example.invalid"]);

        let store = ProjectNotesStore::new(&project.0);
        store
            .set(&project.0, "crate:core", "Original", "fingerprint")
            .unwrap();
        let before = store.list_for_map(&map("fingerprint")).unwrap();
        assert_eq!(before[0].author, "Updater <updater@example.invalid>");

        // Pin a stale updatedAt so a refresh is observable without sleeping.
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(project.0.join(".lightwell/notes.json")).unwrap())
                .unwrap();
        document["notes"]["crate:core"]["updatedAt"] = serde_json::json!("2000-01-01T00:00:00Z");
        document["notes"]["crate:core"]["author"] = serde_json::json!("stale-author");
        fs::write(
            project.0.join(".lightwell/notes.json"),
            serde_json::to_vec_pretty(&document).unwrap(),
        )
        .unwrap();

        update_project_note_text(&project.0, &map("fingerprint"), "crate:core", "Edited").unwrap();
        let after = store.list_for_map(&map("fingerprint")).unwrap();
        assert_eq!(after[0].text, "Edited");
        assert_eq!(after[0].author, "Updater <updater@example.invalid>");
        assert_ne!(after[0].updated_at, "2000-01-01T00:00:00Z");
        assert!(after[0].updated_at.ends_with('Z'));
        assert_eq!(after[0].source_fingerprint, "fingerprint");
    }

    #[test]
    fn format_unix_secs_rfc3339_matches_known_instants() {
        assert_eq!(super::format_unix_secs_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            super::format_unix_secs_rfc3339(1_767_528_000),
            "2026-01-04T12:00:00Z"
        );
    }
}
