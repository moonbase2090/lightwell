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
            let result = self.events.recv().map_err(MapWatchError::EventsClosed)?;
            let events = result.map_err(MapWatchError::DebouncedEvent)?;
            if !events.iter().any(|event| {
                event_is_relevant(&self.repository_path, &self.current_map, &event.path)
            }) {
                continue;
            }

            let workspace = discover_project_workspace(&self.repository_path)?;
            let next_map = map_workspace(workspace, self.project_name.as_deref())?;
            if !same_fingerprints(&self.current_map, &next_map) {
                self.current_map = next_map.clone();
                return Ok(next_map);
            }
        }
    }
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
        source_path
            .extension()
            .is_some_and(|extension| extension == "rs")
            && source_path
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
