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
    pub modules: Vec<RustModule>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RustModule {
    pub name: String,
    pub declaration_path: PathBuf,
    pub declaration_line: usize,
    pub declaration_column: usize,
    pub source_path: Option<PathBuf>,
    pub path_attribute: Option<String>,
    pub attributes: Vec<String>,
    pub children: Vec<RustModule>,
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
pub enum CargoDiscoveryError {
    RepositoryPath {
        path: PathBuf,
        source: io::Error,
    },
    ManifestMissing(PathBuf),
    CargoStart(io::Error),
    CargoFailed {
        status: Option<i32>,
        stderr: String,
    },
    InvalidMetadata(serde_json::Error),
    InvalidManifest {
        path: PathBuf,
        reason: String,
    },
    InvalidManifestToml {
        path: PathBuf,
        source: toml::de::Error,
    },
    WorkspaceMemberPattern {
        pattern: String,
        reason: String,
    },
    InvalidRustSource {
        path: PathBuf,
        reason: String,
    },
    SourceRead {
        path: PathBuf,
        source: io::Error,
    },
    PathOutsideOpenedFolder {
        path: PathBuf,
        opened_root: PathBuf,
    },
}

impl Display for CargoDiscoveryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RepositoryPath { path, source } => {
                write!(
                    formatter,
                    "Could not access repository path {}: {source}",
                    path.display()
                )
            }
            Self::ManifestMissing(path) => {
                write!(formatter, "No Cargo.toml found at {}.", path.display())
            }
            Self::CargoStart(source) => {
                write!(formatter, "Could not start `cargo metadata`: {source}")
            }
            Self::CargoFailed { status, stderr } => write!(
                formatter,
                "`cargo metadata --no-deps` failed with status {}: {}",
                status.map_or_else(|| "unknown".to_owned(), |code| code.to_string()),
                stderr.trim()
            ),
            Self::InvalidMetadata(source) => {
                write!(
                    formatter,
                    "`cargo metadata` returned invalid JSON: {source}"
                )
            }
            Self::InvalidManifest { path, reason } => {
                write!(
                    formatter,
                    "Could not parse Cargo manifest {}: {reason}",
                    path.display()
                )
            }
            Self::InvalidManifestToml { path, source } => {
                write!(
                    formatter,
                    "Could not parse Cargo manifest {}: {source}",
                    path.display()
                )
            }
            Self::WorkspaceMemberPattern { pattern, reason } => write!(
                formatter,
                "Could not expand Cargo workspace member pattern `{pattern}`: {reason}"
            ),
            Self::SourceRead { path, source } => {
                write!(
                    formatter,
                    "Could not read Rust source {}: {source}",
                    path.display()
                )
            }
            Self::InvalidRustSource { path, reason } => write!(
                formatter,
                "Could not parse Rust source {}: {reason}",
                path.display()
            ),
            Self::PathOutsideOpenedFolder { path, opened_root } => write!(
                formatter,
                "Path {} is outside the opened folder {}",
                path.display(),
                opened_root.display()
            ),
        }
    }
}

impl Error for CargoDiscoveryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::RepositoryPath { source, .. }
            | Self::CargoStart(source)
            | Self::SourceRead { source, .. } => Some(source),
            Self::InvalidMetadata(source) => Some(source),
            Self::InvalidManifestToml { source, .. } => Some(source),
            Self::ManifestMissing(_)
            | Self::CargoFailed { .. }
            | Self::InvalidManifest { .. }
            | Self::WorkspaceMemberPattern { .. }
            | Self::InvalidRustSource { .. }
            | Self::PathOutsideOpenedFolder { .. } => None,
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
) -> Result<CargoWorkspace, CargoDiscoveryError> {
    let requested_path = repository_path.as_ref();
    let root =
        requested_path
            .canonicalize()
            .map_err(|source| CargoDiscoveryError::RepositoryPath {
                path: requested_path.to_owned(),
                source,
            })?;
    let manifest_path = root.join("Cargo.toml");
    if !manifest_path.is_file() {
        return Err(CargoDiscoveryError::ManifestMissing(manifest_path));
    }

    let output = match Command::new("cargo")
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
    {
        Ok(output) => output,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return crate::manifest::discover_cargo_workspace(&root);
        }
        Err(source) => return Err(CargoDiscoveryError::CargoStart(source)),
    };
    if !output.status.success() {
        if matches!(output.status.code(), Some(126) | Some(127)) {
            return crate::manifest::discover_cargo_workspace(&root);
        }
        return Err(CargoDiscoveryError::CargoFailed {
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    let metadata: CargoMetadata =
        serde_json::from_slice(&output.stdout).map_err(CargoDiscoveryError::InvalidMetadata)?;
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
            .then_with(|| left.manifest_path.cmp(&right.manifest_path))
    });

    let mut workspace = CargoWorkspace {
        root: metadata.workspace_root,
        packages,
    };
    for package in &mut workspace.packages {
        for target in &mut package.targets {
            crate::rust_source::populate_target_modules(target)?;
        }
    }
    Ok(workspace)
}

#[doc(hidden)]
pub fn discover_cargo_workspace_manifest_only(
    repository_path: impl AsRef<Path>,
) -> Result<CargoWorkspace, CargoDiscoveryError> {
    let opened_root = crate::path_confinement::opened_root(repository_path.as_ref())?;
    crate::manifest::discover_cargo_workspace(&opened_root)
}

fn normalize_package(package: MetadataPackage) -> CargoPackage {
    let mut targets: Vec<_> = package
        .targets
        .into_iter()
        .map(|target| CargoTarget {
            name: target.name,
            kind: target.kind,
            source_path: target.src_path,
            modules: Vec::new(),
        })
        .collect();
    targets.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.source_path.cmp(&right.source_path))
    });
    let mut dependencies: Vec<_> = package
        .dependencies
        .into_iter()
        .map(|dependency| CargoDependency {
            name: dependency.name,
            path: dependency.path,
            kind: dependency.kind.unwrap_or(CargoDependencyKind::Normal),
        })
        .collect();
    dependencies.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| dependency_kind_order(left.kind).cmp(&dependency_kind_order(right.kind)))
            .then_with(|| left.path.cmp(&right.path))
    });

    CargoPackage {
        name: package.name,
        version: package.version,
        manifest_path: package.manifest_path,
        description: package.description,
        targets,
        features: package.features.into_keys().collect(),
        dependencies,
    }
}

fn dependency_kind_order(kind: CargoDependencyKind) -> u8 {
    match kind {
        CargoDependencyKind::Normal => 0,
        CargoDependencyKind::Build => 1,
        CargoDependencyKind::Dev => 2,
    }
}
