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
    #[serde(rename = "workspace_root")]
    _workspace_root: PathBuf,
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

    let output = match cargo_program()
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
        // A missing or unusable cargo exits 126 or 127. qemu-user reports that
        // as a process status instead of the ENOENT the native spawn returns.
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
        root: root.clone(),
        packages,
    };
    workspace
        .packages
        .retain(|package| package.manifest_path.starts_with(&root));
    for package in &mut workspace.packages {
        package.targets.retain(|target| {
            crate::path_confinement::confined_canonical(&target.source_path, &root).is_ok()
        });
        for target in &mut package.targets {
            crate::rust_source::populate_target_modules(target, &root)?;
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

#[cfg(test)]
thread_local! {
    static CARGO_PROGRAM: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn cargo_program() -> Command {
    #[cfg(test)]
    if let Some(program) = CARGO_PROGRAM.with(|program| program.borrow().clone()) {
        return Command::new(program);
    }
    Command::new("cargo")
}

#[cfg(test)]
mod tests {
    use super::{discover_cargo_workspace, CARGO_PROGRAM};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
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
                "lightwell-cargo-{label}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(root.join("src")).expect("fixture source folder should be created");
            fs::write(
                root.join("Cargo.toml"),
                "[package]\nname = \"fallback-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
            )
            .expect("fixture manifest should be written");
            fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n")
                .expect("fixture library should be written");
            let root = root.canonicalize().expect("fixture root should resolve");
            Self { root }
        }

        fn cargo_script(&self, script: &str) -> PathBuf {
            let bin_dir = self.root.join("bin");
            fs::create_dir_all(&bin_dir).expect("fake cargo folder should be created");
            let program = bin_dir.join("cargo");
            fs::write(&program, script).expect("fake cargo should be written");
            let mut permissions = fs::metadata(&program)
                .expect("fake cargo should have metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&program, permissions).expect("fake cargo should be executable");
            program
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct CargoOverride;

    impl CargoOverride {
        fn set(program: PathBuf) -> Self {
            CARGO_PROGRAM.with(|slot| *slot.borrow_mut() = Some(program));
            Self
        }
    }

    impl Drop for CargoOverride {
        fn drop(&mut self) {
            CARGO_PROGRAM.with(|slot| *slot.borrow_mut() = None);
        }
    }

    #[test]
    fn cargo_exit_127_uses_the_manifest() {
        let fixture = Fixture::new("missing");
        let _override = CargoOverride::set(fixture.cargo_script("#!/bin/sh\nexit 127\n"));
        let workspace = discover_cargo_workspace(&fixture.root)
            .expect("a missing cargo should fall back to the manifest");
        assert_eq!(workspace.packages.len(), 1);
        assert_eq!(workspace.packages[0].name, "fallback-fixture");
        assert_eq!(
            workspace.packages[0].manifest_path,
            fixture.root.join("Cargo.toml")
        );
    }

    #[test]
    fn cargo_exit_1_stays_a_discovery_failure() {
        let fixture = Fixture::new("failed");
        let _override = CargoOverride::set(
            fixture.cargo_script("#!/bin/sh\necho 'metadata exploded' >&2\nexit 1\n"),
        );
        let message = discover_cargo_workspace(&fixture.root)
            .expect_err("a real cargo failure should stay visible")
            .to_string();
        assert!(
            message.contains("status 1"),
            "unexpected discovery error: {message}"
        );
        assert!(
            message.contains("metadata exploded"),
            "stderr should be kept: {message}"
        );
    }
}
