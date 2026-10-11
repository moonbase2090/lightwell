use crate::metadata::CargoDiscoveryError;
use std::path::{Path, PathBuf};

pub(crate) fn opened_root(repository_path: &Path) -> Result<PathBuf, CargoDiscoveryError> {
    repository_path
        .canonicalize()
        .map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: repository_path.to_owned(),
            source,
        })
}

pub(crate) fn is_confined_to(canonical_path: &Path, opened_root: &Path) -> bool {
    canonical_path == opened_root || canonical_path.starts_with(opened_root)
}

#[allow(dead_code)]
pub(crate) fn confined_canonical(
    path: &Path,
    opened_root: &Path,
) -> Result<PathBuf, CargoDiscoveryError> {
    let canonical = path
        .canonicalize()
        .map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: path.to_owned(),
            source,
        })?;
    if is_confined_to(&canonical, opened_root) {
        Ok(canonical)
    } else {
        Err(CargoDiscoveryError::PathOutsideOpenedFolder {
            path: canonical,
            opened_root: opened_root.to_owned(),
        })
    }
}

#[allow(dead_code)]
pub(crate) fn confined_join(
    base: &Path,
    relative: &str,
    opened_root: &Path,
) -> Result<PathBuf, CargoDiscoveryError> {
    confined_canonical(&base.join(relative), opened_root)
}
