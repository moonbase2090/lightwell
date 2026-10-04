use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CargoWorkspace {
    pub root: PathBuf,
    pub packages: Vec<CargoPackage>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CargoPackage {
    pub id: String,
    pub name: String,
    pub version: String,
    pub manifest_path: PathBuf,
    pub description: Option<String>,
    pub targets: Vec<CargoTarget>,
    pub features: Vec<String>,
    pub dependencies: Vec<CargoDependency>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CargoTarget {
    pub name: String,
    pub kind: Vec<String>,
    pub source_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CargoDependency {
    pub name: String,
    pub path: Option<PathBuf>,
    pub kind: CargoDependencyKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CargoDependencyKind {
    Normal,
    Build,
    Dev,
}

#[derive(Debug)]
pub enum CargoMetadataError {
    RepositoryPath { path: PathBuf, source: io::Error },
    ManifestMissing(PathBuf),
    CargoMissing,
    CargoStart(io::Error),
    CargoFailed { status: Option<i32>, stderr: String },
    InvalidMetadata(serde_json::Error),
}

impl Display for CargoMetadataError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RepositoryPath { path, source } => {
                write!(formatter, "Could not access repository path {}: {source}", path.display())
            }
            Self::ManifestMissing(path) => {
                write!(formatter, "No Cargo.toml found at {}.", path.display())
            }
            Self::CargoMissing => write!(
                formatter,
                "Cargo was not found on PATH. Install Rust with rustup or add the `cargo` executable to PATH."
            ),
            Self::CargoStart(source) => write!(formatter, "Could not start `cargo metadata`: {source}"),
            Self::CargoFailed { status, stderr } => write!(
                formatter,
                "`cargo metadata --no-deps` failed with status {}: {}",
                status.map_or_else(|| "unknown".to_owned(), |code| code.to_string()),
                stderr.trim()
            ),
            Self::InvalidMetadata(source) => {
                write!(formatter, "`cargo metadata` returned invalid JSON: {source}")
            }
        }
    }
}

impl Error for CargoMetadataError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::RepositoryPath { source, .. } | Self::CargoStart(source) => Some(source),
            Self::InvalidMetadata(source) => Some(source),
            Self::ManifestMissing(_) | Self::CargoMissing | Self::CargoFailed { .. } => None,
        }
    }
}

#[derive(Deserialize)]
struct CargoMetadata {
    workspace_root: PathBuf,
    workspace_members: Vec<String>,
    packages: Vec<MetadataPackage>,
}

#[derive(Deserialize)]
struct MetadataPackage {
    id: String,
    name: String,
    version: String,
    manifest_path: PathBuf,
    description: Option<String>,
    targets: Vec<MetadataTarget>,
    features: BTreeMap<String, Vec<String>>,
    dependencies: Vec<MetadataDependency>,
}

#[derive(Deserialize)]
struct MetadataTarget {
    name: String,
    kind: Vec<String>,
    src_path: PathBuf,
}

#[derive(Deserialize)]
struct MetadataDependency {
    name: String,
    path: Option<PathBuf>,
    kind: Option<CargoDependencyKind>,
}

impl<'de> Deserialize<'de> for CargoDependencyKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "normal" => Ok(Self::Normal),
            "build" => Ok(Self::Build),
            "dev" => Ok(Self::Dev),
            _ => Err(serde::de::Error::custom(format!(
                "unknown Cargo dependency kind `{value}`"
            ))),
        }
    }
}

pub fn discover_cargo_workspace(
    repository_path: impl AsRef<Path>,
) -> Result<CargoWorkspace, CargoMetadataError> {
    let requested_path = repository_path.as_ref();
    let root =
        requested_path
            .canonicalize()
            .map_err(|source| CargoMetadataError::RepositoryPath {
                path: requested_path.to_owned(),
                source,
            })?;
    let manifest_path = root.join("Cargo.toml");
    if !manifest_path.is_file() {
        return Err(CargoMetadataError::ManifestMissing(manifest_path));
    }

    let output = Command::new("cargo")
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(&manifest_path)
        .current_dir(&root)
        .output()
        .map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                CargoMetadataError::CargoMissing
            } else {
                CargoMetadataError::CargoStart(source)
            }
        })?;
    if !output.status.success() {
        return Err(CargoMetadataError::CargoFailed {
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    let metadata: CargoMetadata =
        serde_json::from_slice(&output.stdout).map_err(CargoMetadataError::InvalidMetadata)?;
    let member_ids: HashSet<String> = metadata.workspace_members.into_iter().collect();
    let mut packages: Vec<_> = metadata
        .packages
        .into_iter()
        .filter(|package| member_ids.contains(&package.id))
        .map(normalize_package)
        .collect();
    packages.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(CargoWorkspace {
        root: metadata.workspace_root,
        packages,
    })
}

fn normalize_package(package: MetadataPackage) -> CargoPackage {
    CargoPackage {
        id: package.id,
        name: package.name,
        version: package.version,
        manifest_path: package.manifest_path,
        description: package.description,
        targets: package
            .targets
            .into_iter()
            .map(|target| CargoTarget {
                name: target.name,
                kind: target.kind,
                source_path: target.src_path,
            })
            .collect(),
        features: package.features.into_keys().collect(),
        dependencies: package
            .dependencies
            .into_iter()
            .map(|dependency| CargoDependency {
                name: dependency.name,
                path: dependency.path,
                kind: dependency.kind.unwrap_or(CargoDependencyKind::Normal),
            })
            .collect(),
    }
}
