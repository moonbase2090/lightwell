use crate::extract::{block_base, map_workspace};
use crate::{discover_cargo_workspace, FactMap, MapExtractionError};
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
        let workspace =
            discover_cargo_workspace(&requested_path).map_err(MapExtractionError::from)?;
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

            let workspace = discover_cargo_workspace(&self.repository_path)
                .map_err(MapExtractionError::from)?;
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
