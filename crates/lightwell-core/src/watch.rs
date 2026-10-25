use crate::extract::{block_base, discover_project_workspace, map_workspace};
use crate::{FactMap, MapExtractionError};
use notify_debouncer_mini::notify::{self, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvError};
use std::time::Duration;

// This matches the timeout in notify-debouncer-mini's example:
// https://docs.rs/notify-debouncer-mini/0.7.0/notify_debouncer_mini/
const DEBOUNCE_DELAY: Duration = Duration::from_secs(2);

pub struct MapWatcher {
    repository_path: PathBuf,
    project_name: Option<String>,
    current_map: FactMap,
    events: Receiver<DebounceEventResult>,
    _debouncer: Debouncer<notify::RecommendedWatcher>,
}

impl MapWatcher {
    pub fn new(
        repository_path: impl AsRef<Path>,
        project_name: Option<&str>,
    ) -> Result<Self, MapWatchError> {
        let requested_path = repository_path.as_ref();
        let requested_path =
            requested_path
                .canonicalize()
                .map_err(|source| MapWatchError::RepositoryPath {
                    path: requested_path.to_owned(),
                    source,
                })?;
        let workspace = discover_project_workspace(&requested_path)?;
        let repository_path = workspace.root.clone();
        let (sender, events) = mpsc::channel();
        let mut debouncer = new_debouncer(DEBOUNCE_DELAY, move |result: DebounceEventResult| {
            let _ = sender.send(result);
        })
        .map_err(MapWatchError::Watch)?;
        debouncer
            .watcher()
            .watch(&repository_path, RecursiveMode::Recursive)
            .map_err(MapWatchError::Watch)?;

        let current_map = map_workspace(workspace, project_name)?;
        Ok(Self {
            repository_path,
            project_name: project_name.map(str::to_owned),
            current_map,
            events,
            _debouncer: debouncer,
        })
    }

    pub fn current_map(&self) -> &FactMap {
        &self.current_map
    }

    pub fn next_changed_map(&mut self) -> Result<FactMap, MapWatchError> {
        loop {
            match self.next_update()? {
                WatchUpdate::Map(map) => return Ok(map),
                WatchUpdate::Notes => continue,
            }
        }
    }

    /// The next map edit, or a `.lightwell/notes.json` edit that leaves the map alone.
    /// A notes-only change does not re-extract the workspace.
    pub fn next_update(&mut self) -> Result<WatchUpdate, MapWatchError> {
        loop {
            let result = self.events.recv().map_err(MapWatchError::EventsClosed)?;
            let events = result.map_err(MapWatchError::DebouncedEvent)?;
            let notes_changed = events
                .iter()
                .any(|event| event_is_notes_file(&self.repository_path, &event.path));
            let map_relevant = events.iter().any(|event| {
                event_is_relevant(&self.repository_path, &self.current_map, &event.path)
            });
            let fingerprints_changed = if map_relevant {
                let workspace = discover_project_workspace(&self.repository_path)?;
                let next_map = map_workspace(workspace, self.project_name.as_deref())?;
                let changed = !same_fingerprints(&self.current_map, &next_map);
                if changed {
                    self.current_map = next_map;
                }
                changed
            } else {
                false
            };
            match classify_watch(map_relevant, fingerprints_changed, notes_changed) {
                WatchClass::Map => return Ok(WatchUpdate::Map(self.current_map.clone())),
                WatchClass::Notes => return Ok(WatchUpdate::Notes),
                WatchClass::Ignore => continue,
            }
        }
    }
}

/// A workspace watch result. [`WatchUpdate::Notes`] means `.lightwell/notes.json` changed
/// and the cached map is still current.
#[derive(Clone, Debug)]
pub enum WatchUpdate {
    Map(FactMap),
    Notes,
}

#[derive(Debug)]
pub enum MapWatchError {
    RepositoryPath {
        path: PathBuf,
        source: std::io::Error,
    },
    Watch(notify::Error),
    Extraction(MapExtractionError),
    DebouncedEvent(notify::Error),
    EventsClosed(RecvError),
}

impl Display for MapWatchError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RepositoryPath { path, source } => write!(
                formatter,
                "Could not access repository path {}: {source}",
                path.display()
            ),
            Self::Watch(source) => write!(formatter, "Could not watch project files: {source}"),
            Self::Extraction(source) => Display::fmt(source, formatter),
            Self::DebouncedEvent(source) => {
                write!(formatter, "File watcher reported an error: {source}")
            }
            Self::EventsClosed(source) => {
                write!(formatter, "File watcher stopped unexpectedly: {source}")
            }
        }
    }
}

impl Error for MapWatchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::RepositoryPath { source, .. } => Some(source),
            Self::Watch(source) => Some(source),
            Self::Extraction(source) => Some(source),
            Self::DebouncedEvent(source) => Some(source),
            Self::EventsClosed(source) => Some(source),
        }
    }
}

impl From<MapExtractionError> for MapWatchError {
    fn from(source: MapExtractionError) -> Self {
        Self::Extraction(source)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WatchClass {
    Ignore,
    Map,
    Notes,
}

/// Map fingerprint changes win so one batch can refresh the map, which already includes notes.
/// Notes-only batches stay on the notes path and must not be classified as a map refresh.
fn classify_watch(
    map_relevant: bool,
    fingerprints_changed: bool,
    notes_changed: bool,
) -> WatchClass {
    if map_relevant && fingerprints_changed {
        WatchClass::Map
    } else if notes_changed {
        WatchClass::Notes
    } else {
        WatchClass::Ignore
    }
}

fn event_is_notes_file(repository_path: &Path, event_path: &Path) -> bool {
    event_path.starts_with(repository_path)
        && event_path.ends_with(Path::new(".lightwell").join("notes.json"))
}

fn event_is_relevant(repository_path: &Path, map: &FactMap, event_path: &Path) -> bool {
    if !event_path.starts_with(repository_path)
        || event_path
            .strip_prefix(repository_path)
            .is_ok_and(|relative| {
                relative.components().next().is_some_and(|component| {
                    matches!(
                        component.as_os_str().to_str(),
                        Some(".git" | "target" | "node_modules")
                    )
                })
            })
    {
        return false;
    }

    if event_path
        .file_name()
        .is_some_and(|name| name == "Cargo.toml")
    {
        return true;
    }

    map.blocks.iter().any(|block| {
        let Some(source_path) = block_base(block).source_path.as_deref() else {
            return false;
        };
        let source_path = repository_path.join(source_path);
        if event_path == source_path {
            return true;
        }
        source_path.extension().is_some_and(|extension| {
            matches!(
                extension.to_string_lossy().to_ascii_lowercase().as_str(),
                "rs" | "cs" | "vb" | "csproj" | "vbproj" | "sln"
            )
        }) && source_path
            .parent()
            .is_some_and(|parent| event_path.starts_with(parent))
    })
}

fn same_fingerprints(previous: &FactMap, next: &FactMap) -> bool {
    previous
        .blocks
        .iter()
        .map(|block| {
            let base = block_base(block);
            (&base.id, &base.fingerprint)
        })
        .eq(next.blocks.iter().map(|block| {
            let base = block_base(block);
            (&base.id, &base.fingerprint)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::extract_cargo_map;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "lightwell-watch-{label}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(root.join("src")).expect("fixture source folder should be created");
            fs::write(
                root.join("Cargo.toml"),
                "[package]\nname = \"watch-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
            )
            .expect("fixture manifest should be written");
            fs::write(root.join("src/lib.rs"), "pub mod before;\n")
                .expect("fixture library should be written");
            fs::write(root.join("src/before.rs"), "pub fn value() -> u8 { 1 }\n")
                .expect("fixture module should be written");
            // Event paths are canonical, so the fixture root must be too.
            let root = root.canonicalize().expect("fixture root should resolve");
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn manifests_and_mapped_sources_are_relevant() {
        let fixture = Fixture::new("relevant");
        let map = extract_cargo_map(&fixture.root, None).expect("fixture map should extract");
        let relevant =
            |relative: &str| event_is_relevant(&fixture.root, &map, &fixture.root.join(relative));

        assert!(relevant("Cargo.toml"));
        assert!(relevant("src/before.rs"));
        assert!(
            relevant("src/added.rs"),
            "a new file beside a mapped module can change the map"
        );
        assert!(!relevant("README.md"));
        assert!(
            !relevant(".lightwell/notes.json"),
            "notes.json must not force a map re-extract"
        );
        assert!(event_is_notes_file(
            &fixture.root,
            &fixture.root.join(".lightwell/notes.json")
        ));
        assert!(!event_is_notes_file(
            &fixture.root,
            &fixture.root.join(".lightwell/notes.lock")
        ));
        assert_eq!(
            classify_watch(false, false, true),
            WatchClass::Notes,
            "a notes-only batch must not re-extract the map"
        );
        assert_eq!(classify_watch(true, true, true), WatchClass::Map);
        assert_eq!(
            classify_watch(true, false, true),
            WatchClass::Notes,
            "an unchanged map with a notes edit reloads notes only"
        );
        assert_eq!(classify_watch(false, false, false), WatchClass::Ignore);
        assert_eq!(classify_watch(true, true, false), WatchClass::Map);
    }

    #[test]
    fn generated_and_outside_paths_are_not_relevant() {
        let fixture = Fixture::new("ignored");
        let map = extract_cargo_map(&fixture.root, None).expect("fixture map should extract");

        for ignored in [
            ".git/Cargo.toml",
            "target/debug/Cargo.toml",
            "node_modules/pkg/Cargo.toml",
        ] {
            assert!(
                !event_is_relevant(&fixture.root, &map, &fixture.root.join(ignored)),
                "{ignored} should be ignored"
            );
        }
        assert!(!event_is_relevant(
            &fixture.root,
            &map,
            &fixture.root.with_extension("sibling").join("Cargo.toml"),
        ));
    }

    #[test]
    fn fingerprint_comparison_notices_source_edits() {
        let fixture = Fixture::new("fingerprints");
        let before = extract_cargo_map(&fixture.root, None).expect("fixture map should extract");
        assert!(same_fingerprints(&before, &before.clone()));

        fs::write(
            fixture.root.join("src/before.rs"),
            "pub fn value() -> u8 { 2 }\n",
        )
        .expect("fixture module should be edited");
        let after = extract_cargo_map(&fixture.root, None).expect("edited map should extract");
        assert!(!same_fingerprints(&before, &after));
    }

    #[test]
    fn watcher_returns_edited_maps_and_recovers_from_extraction_errors() {
        let fixture = Fixture::new("watcher");
        let mut watcher = MapWatcher::new(&fixture.root, None).expect("watcher should start");
        let initial = watcher.current_map().clone();

        let manifest = fixture.root.join("Cargo.toml");
        let valid_manifest = fs::read_to_string(&manifest).expect("manifest should be readable");
        fs::write(&manifest, "[package\n").expect("broken manifest should be written");
        assert!(matches!(
            watcher.next_changed_map(),
            Err(MapWatchError::Extraction(_))
        ));

        fs::write(&manifest, valid_manifest).expect("manifest should be restored");
        fs::write(
            fixture.root.join("src/before.rs"),
            "pub fn value() -> u8 { 2 }\n",
        )
        .expect("fixture module should be edited");
        let changed = watcher
            .next_changed_map()
            .expect("watcher should recover and report the edit");
        assert!(!same_fingerprints(&initial, &changed));
        assert!(same_fingerprints(watcher.current_map(), &changed));
    }

    #[test]
    fn watcher_refreshes_projects_without_a_root_cargo_manifest() {
        let fixture = Fixture::new("no-cargo");
        fs::remove_file(fixture.root.join("Cargo.toml"))
            .expect("fixture manifest should be removed");
        fs::remove_file(fixture.root.join("src/lib.rs"))
            .expect("fixture library should be removed");
        fs::remove_file(fixture.root.join("src/before.rs"))
            .expect("fixture module should be removed");
        fs::write(
            fixture.root.join("package.json"),
            "{\"name\": \"web-fixture\", \"version\": \"0.1.0\"}\n",
        )
        .expect("package manifest should be written");
        fs::write(
            fixture.root.join("src/index.ts"),
            "export function value(): number { return 1; }\n",
        )
        .expect("TypeScript module should be written");

        let mut watcher =
            MapWatcher::new(&fixture.root, None).expect("watcher should start without Cargo.toml");
        let initial = watcher.current_map().clone();
        assert!(
            !initial.blocks.is_empty(),
            "the TypeScript module should be mapped"
        );

        fs::write(
            fixture.root.join("src/index.ts"),
            "export function value(): number { return 2; }\n",
        )
        .expect("TypeScript module should be edited");
        let changed = watcher
            .next_changed_map()
            .expect("watcher should refresh without Cargo.toml");
        assert!(!same_fingerprints(&initial, &changed));
    }

    #[test]
    fn notes_json_changes_reload_notes_without_replacing_the_map() {
        let fixture = Fixture::new("notes-json");
        let mut watcher = MapWatcher::new(&fixture.root, None).expect("watcher should start");
        let before = watcher.current_map().clone();
        fs::create_dir_all(fixture.root.join(".lightwell"))
            .expect("notes folder should be created");
        fs::write(
            fixture.root.join(".lightwell/notes.json"),
            "{\n  \"schemaVersion\": 1,\n  \"notes\": {}\n}\n",
        )
        .expect("notes file should be written");

        match watcher
            .next_update()
            .expect("notes change should be reported")
        {
            WatchUpdate::Notes => {}
            WatchUpdate::Map(_) => panic!("notes.json must not re-extract the map"),
        }
        assert!(same_fingerprints(&before, watcher.current_map()));
    }

    #[test]
    fn watcher_still_rejects_folders_with_no_project_manifest() {
        let fixture = Fixture::new("no-manifest");
        fs::remove_file(fixture.root.join("Cargo.toml"))
            .expect("fixture manifest should be removed");
        assert!(matches!(
            MapWatcher::new(&fixture.root, None),
            Err(MapWatchError::Extraction(_))
        ));
    }
}
