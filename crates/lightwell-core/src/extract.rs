use crate::facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock,
};
use crate::metadata::{
    discover_cargo_workspace, CargoDependencyKind, CargoDiscoveryError, CargoPackage,
    CargoWorkspace, RustModule,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum MapExtractionError {
    Discovery(CargoDiscoveryError),
    InputRead { path: PathBuf, source: io::Error },
}

impl Display for MapExtractionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Discovery(source) => Display::fmt(source, formatter),
            Self::InputRead { path, source } => write!(
                formatter,
                "Could not read a file used by Rust extraction at {}: {source}",
                path.display()
            ),
        }
    }
}

impl Error for MapExtractionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Discovery(source) => Some(source),
            Self::InputRead { source, .. } => Some(source),
        }
    }
}

impl From<CargoDiscoveryError> for MapExtractionError {
    fn from(source: CargoDiscoveryError) -> Self {
        Self::Discovery(source)
    }
}

pub fn extract_cargo_map(
    repository_path: impl AsRef<Path>,
    project_name: Option<&str>,
) -> Result<FactMap, MapExtractionError> {
    let workspace = discover_cargo_workspace(repository_path)?;
    map_workspace(workspace, project_name)
}

fn map_workspace(
    workspace: CargoWorkspace,
    project_name: Option<&str>,
) -> Result<FactMap, MapExtractionError> {
    let root_path = workspace.root.clone();
    let project_label = project_name
        .map(str::to_owned)
        .or_else(|| {
            root_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "Workspace".to_owned());
    let project_id = format!("workspace:{}", slug(&project_label));
    let mut fingerprints = FileFingerprints::default();
    let package_id_by_manifest: HashMap<_, _> = workspace
        .packages
        .iter()
        .map(|package| {
            (
                normalize_path(&package.manifest_path),
                format!("crate:{}", slug(&package.name)),
            )
        })
        .collect();
    let mut blocks = Vec::new();
    let mut connections = Vec::new();
    let mut crate_fingerprints = Vec::new();

    for package in &workspace.packages {
        append_package(
            package,
            &root_path,
            &project_id,
            &mut fingerprints,
            &mut blocks,
            &mut connections,
            &mut crate_fingerprints,
        )?;
    }

    let mut workspace_inputs: Vec<_> = crate_fingerprints
        .into_iter()
        .map(|(name, fingerprint)| format!("{name}:{fingerprint}"))
        .collect();
    workspace_inputs.sort();
    let workspace_fingerprint = hash_text(&workspace_inputs.join("\n"));
    blocks.insert(
        0,
        FactBlock::Workspace(WorkspaceBlock {
            base: BlockBase {
                id: project_id.clone(),
                label: project_label.clone(),
                parent_id: None,
                children: Vec::new(),
                source_path: Some(relative_path(&root_path, &root_path.join("Cargo.toml"))),
                fingerprint: workspace_fingerprint,
            },
            member_count: workspace.packages.len(),
        }),
    );

    append_dependency_connections(&workspace, &package_id_by_manifest, &mut connections);
    derive_children(&mut blocks);

    let workspace_children = block_base(&blocks[0]).children.clone();
    let groups = vec![FactGroup {
        id: "group:crates".to_owned(),
        label: "Workspace crates".to_owned(),
        member_ids: workspace_children,
    }];
    let stats = MapStats {
        blocks: blocks.len(),
        connections: connections.len(),
        crates: blocks
            .iter()
            .filter(|block| matches!(block, FactBlock::Crate(_)))
            .count(),
        apps: blocks
            .iter()
            .filter(|block| matches!(block, FactBlock::App(_)))
            .count(),
        modules: blocks
            .iter()
            .filter(|block| matches!(block, FactBlock::Module(_)))
            .count(),
        cargo_features: blocks
            .iter()
            .filter(|block| matches!(block, FactBlock::CargoFeature(_)))
            .count(),
    };

    Ok(FactMap::schema_v1(
        Project {
            id: project_id,
            name: project_label,
            root_path: ".".to_owned(),
        },
        blocks,
        connections,
        groups,
        stats,
    ))
}

fn append_package(
    package: &CargoPackage,
    root_path: &Path,
    project_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
    crate_fingerprints: &mut Vec<(String, String)>,
) -> Result<(), MapExtractionError> {
    let crate_id = format!("crate:{}", slug(&package.name));
    let manifest_path = relative_path(root_path, &package.manifest_path);
    let manifest_fingerprint = fingerprints.file(&package.manifest_path)?;
    let crate_index = blocks.len();
    blocks.push(FactBlock::Crate(CrateBlock {
        base: BlockBase {
            id: crate_id.clone(),
            label: package.name.clone(),
            parent_id: Some(project_id.to_owned()),
            children: Vec::new(),
            source_path: Some(manifest_path.clone()),
            fingerprint: manifest_fingerprint.clone(),
        },
        package_name: package.name.clone(),
        version: package.version.clone(),
        description: package.description.clone(),
    }));
    connections.push(contains_connection(project_id, &crate_id));

    let mut targets: Vec<_> = package
        .targets
        .iter()
        .filter(|target| target.kind.iter().any(|kind| kind == "bin"))
        .collect();
    targets.sort_by(|left, right| left.name.cmp(&right.name));
    for target in targets {
        let app_id = format!("app:{}:{}", slug(&package.name), slug(&target.name));
        let entry_path = relative_path(root_path, &target.source_path);
        let app_fingerprint = fingerprints.file(&target.source_path)?;
        blocks.push(FactBlock::App(AppBlock {
            base: BlockBase {
                id: app_id.clone(),
                label: target.name.clone(),
                parent_id: Some(crate_id.clone()),
                children: Vec::new(),
                source_path: Some(entry_path.clone()),
                fingerprint: app_fingerprint,
            },
            package_name: package.name.clone(),
            target_name: target.name.clone(),
            entry_path,
            target_kind: target.kind.join(", "),
        }));
        connections.push(contains_connection(&crate_id, &app_id));
        append_modules(
            &target.modules,
            ModuleContext {
                package_name: &package.name,
                root_path,
                parent_id: &app_id,
                parent_module_path: &target.name,
            },
            fingerprints,
            blocks,
            connections,
        )?;
    }

    if let Some(target) = package.targets.iter().find(|target| {
        target.kind.iter().any(|kind| {
            matches!(
                kind.as_str(),
                "lib" | "rlib" | "dylib" | "cdylib" | "staticlib"
            )
        })
    }) {
        let root_module_id = module_id(&package.name, "crate root");
        let root_source_path = relative_path(root_path, &target.source_path);
        let root_fingerprint = fingerprints.file(&target.source_path)?;
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: root_module_id.clone(),
                label: "crate root".to_owned(),
                parent_id: Some(crate_id.clone()),
                children: Vec::new(),
                source_path: Some(root_source_path),
                fingerprint: root_fingerprint,
            },
            package_name: package.name.clone(),
            module_path: "crate root".to_owned(),
            declared_by_path: manifest_path.clone(),
            cfg_attributes: Vec::new(),
            unresolved: false,
        }));
        connections.push(contains_connection(&crate_id, &root_module_id));
        append_modules(
            &target.modules,
            ModuleContext {
                package_name: &package.name,
                root_path,
                parent_id: &root_module_id,
                parent_module_path: "crate root",
            },
            fingerprints,
            blocks,
            connections,
        )?;
    }

    for feature_name in &package.features {
        let feature_id = format!(
            "cargo-feature:{}:{}",
            slug(&package.name),
            slug(feature_name)
        );
        blocks.push(FactBlock::CargoFeature(CargoFeatureBlock {
            base: BlockBase {
                id: feature_id.clone(),
                label: feature_name.clone(),
                parent_id: Some(crate_id.clone()),
                children: Vec::new(),
                source_path: Some(manifest_path.clone()),
                fingerprint: manifest_fingerprint.clone(),
            },
            package_name: package.name.clone(),
            feature_name: feature_name.clone(),
        }));
        connections.push(contains_connection(&crate_id, &feature_id));
    }

    let mut package_inputs: Vec<_> = blocks[crate_index + 1..]
        .iter()
        .map(|block| {
            let base = block_base(block);
            format!("{}:{}", base.id, base.fingerprint)
        })
        .collect();
    package_inputs.sort();
    let crate_fingerprint = hash_text(
        &std::iter::once(manifest_fingerprint)
            .chain(package_inputs)
            .collect::<Vec<_>>()
            .join("\n"),
    );
    if let FactBlock::Crate(crate_block) = &mut blocks[crate_index] {
        crate_block.base.fingerprint = crate_fingerprint.clone();
    }
    crate_fingerprints.push((package.name.clone(), crate_fingerprint));
    Ok(())
}

struct ModuleContext<'a> {
    package_name: &'a str,
    root_path: &'a Path,
    parent_id: &'a str,
    parent_module_path: &'a str,
}

fn append_modules(
    modules: &[RustModule],
    context: ModuleContext<'_>,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    for module in modules {
        let module_path = if context.parent_module_path.is_empty() {
            module.name.clone()
        } else {
            format!("{}::{}", context.parent_module_path, module.name)
        };
        let id = module_id(context.package_name, &module_path);
        let source_path = module
            .source_path
            .as_ref()
            .map(|path| relative_path(context.root_path, path));
        let fingerprint = match &module.source_path {
            Some(path) => fingerprints.file(path)?,
            None => hash_text(&format!(
                "{}:{}:{}",
                relative_path(context.root_path, &module.declaration_path),
                module_path,
                module.attributes.join("")
            )),
        };
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: id.clone(),
                label: module.name.clone(),
                parent_id: Some(context.parent_id.to_owned()),
                children: Vec::new(),
                source_path,
                fingerprint,
            },
            package_name: context.package_name.to_owned(),
            module_path: module_path.clone(),
            declared_by_path: relative_path(context.root_path, &module.declaration_path),
            cfg_attributes: module.attributes.clone(),
            unresolved: module.source_path.is_none(),
        }));
        connections.push(contains_connection(context.parent_id, &id));
        append_modules(
            &module.children,
            ModuleContext {
                package_name: context.package_name,
                root_path: context.root_path,
                parent_id: &id,
                parent_module_path: &module_path,
            },
            fingerprints,
            blocks,
            connections,
        )?;
    }
    Ok(())
}

fn append_dependency_connections(
    workspace: &CargoWorkspace,
    package_id_by_manifest: &HashMap<PathBuf, String>,
    connections: &mut Vec<Connection>,
) {
    let mut connection_ids = HashSet::new();
    for package in &workspace.packages {
        let source_id = format!("crate:{}", slug(&package.name));
        for dependency in &package.dependencies {
            let dependency_scope = match dependency.kind {
                CargoDependencyKind::Normal => DependencyScope::Normal,
                CargoDependencyKind::Build => DependencyScope::Build,
                CargoDependencyKind::Dev => continue,
            };
            let Some(path) = &dependency.path else {
                continue;
            };
            let manifest_path = normalize_path(&path.join("Cargo.toml"));
            let Some(target_id) = package_id_by_manifest.get(&manifest_path) else {
                continue;
            };
            if target_id == &source_id {
                continue;
            }
            let id = connection_id("depends_on", &source_id, target_id);
            if connection_ids.insert(id.clone()) {
                connections.push(Connection::DependsOn {
                    id,
                    source: source_id.clone(),
                    target: target_id.clone(),
                    dependency_scope,
                });
            }
        }
    }
}

fn contains_connection(source: &str, target: &str) -> Connection {
    Connection::Contains {
        id: connection_id("contains", source, target),
        source: source.to_owned(),
        target: target.to_owned(),
    }
}

fn connection_id(kind: &str, source: &str, target: &str) -> String {
    format!("{kind}:{source}->{target}")
}

fn module_id(package_name: &str, module_path: &str) -> String {
    format!("module:{}:{module_path}", slug(package_name))
}

fn slug(value: &str) -> String {
    let mut slug = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn hash_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[derive(Default)]
struct FileFingerprints {
    values: HashMap<PathBuf, String>,
}

impl FileFingerprints {
    fn file(&mut self, path: &Path) -> Result<String, MapExtractionError> {
        let path = normalize_path(path);
        if let Some(fingerprint) = self.values.get(&path) {
            return Ok(fingerprint.clone());
        }
        let contents = fs::read(&path).map_err(|source| MapExtractionError::InputRead {
            path: path.clone(),
            source,
        })?;
        let fingerprint = format!("{:x}", Sha256::digest(contents));
        self.values.insert(path, fingerprint.clone());
        Ok(fingerprint)
    }
}

fn derive_children(blocks: &mut [FactBlock]) {
    let mut children = HashMap::<String, Vec<String>>::new();
    for block in blocks.iter() {
        let base = block_base(block);
        if let Some(parent_id) = &base.parent_id {
            children
                .entry(parent_id.clone())
                .or_default()
                .push(base.id.clone());
        }
    }
    for block in blocks {
        let base = block_base_mut(block);
        base.children = children.remove(&base.id).unwrap_or_default();
    }
}

fn block_base(block: &FactBlock) -> &BlockBase {
    match block {
        FactBlock::Workspace(block) => &block.base,
        FactBlock::Crate(block) => &block.base,
        FactBlock::App(block) => &block.base,
        FactBlock::Module(block) => &block.base,
        FactBlock::CargoFeature(block) => &block.base,
    }
}

fn block_base_mut(block: &mut FactBlock) -> &mut BlockBase {
    match block {
        FactBlock::Workspace(block) => &mut block.base,
        FactBlock::Crate(block) => &mut block.base,
        FactBlock::App(block) => &mut block.base,
        FactBlock::Module(block) => &mut block.base,
        FactBlock::CargoFeature(block) => &mut block.base,
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn relative_path(root: &Path, path: &Path) -> String {
    let root = normalize_path(root);
    let path = normalize_path(path);
    if let Ok(relative) = path.strip_prefix(&root) {
        return path_to_slashes(relative);
    }
    let root_components: Vec<_> = root.components().collect();
    let path_components: Vec<_> = path.components().collect();
    let common = root_components
        .iter()
        .zip(&path_components)
        .take_while(|(left, right)| left == right)
        .count();
    if common == 0 {
        return path_to_slashes(&path);
    }
    let mut parts = Vec::new();
    for component in &root_components[common..] {
        if matches!(component, Component::Normal(_)) {
            parts.push("..".to_owned());
        }
    }
    for component in &path_components[common..] {
        parts.push(component.as_os_str().to_string_lossy().into_owned());
    }
    parts.join("/")
}

fn path_to_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
