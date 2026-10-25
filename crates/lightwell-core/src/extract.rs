use crate::cpp_source::{discover_cpp_targets, CppFile, CppSymbol, CppTarget};
use crate::dotnet_source::{
    discover_dotnet, DotnetFile, DotnetImport, DotnetSymbolKind, DotnetWorkspace,
};
use crate::facts::{
    AppBlock, BlockBase, CargoFeatureBlock, Connection, CrateBlock, DependencyScope, FactBlock,
    FactGroup, FactMap, MapStats, ModuleBlock, Project, WorkspaceBlock,
};
use crate::go_source::{discover_go_packages, go_import_alias_paths, GoFile, GoPackage, GoSymbol};
use crate::metadata::{
    discover_cargo_workspace, CargoDependencyKind, CargoDiscoveryError, CargoPackage,
    CargoWorkspace, RustModule,
};
use crate::php_source::{discover_php_packages, PhpFile, PhpPackage, PhpSymbol};
use crate::python_source::{discover_python_modules, PythonModule, PythonSymbol};
use crate::ruby_source::{
    discover_ruby_packages, resolve_ruby_require, RubyFile, RubyPackage, RubySymbol,
};
use crate::typescript_source::{discover_typescript_modules, TypeScriptModule, TypeScriptSymbol};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::ffi::OsStr;
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

const PROJECT_MANIFESTS: &[&str] = &[
    "Cargo.toml",
    "go.mod",
    "go.work",
    "composer.json",
    "Gemfile",
    "package.json",
    "tsconfig.json",
    "jsconfig.json",
    "CMakeLists.txt",
];

/// The manifest that shows `root` is a project Lightwell can open.
/// `Cargo.toml` wins when a folder is also a Node, TypeScript, or .NET project.
pub fn project_manifest(root: &Path) -> Option<PathBuf> {
    if let Some(path) = PROJECT_MANIFESTS.iter().find_map(|name| {
        let path = root.join(name);
        path.is_file().then_some(path)
    }) {
        return Some(path);
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_dotnet_project_file(&path) {
            return Some(path);
        }
    }
    None
}

fn is_dotnet_project_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("sln" | "csproj" | "vbproj")
    )
}

pub fn extract_cargo_map(
    repository_path: impl AsRef<Path>,
    project_name: Option<&str>,
) -> Result<FactMap, MapExtractionError> {
    map_workspace(discover_project_workspace(repository_path)?, project_name)
}

/// Find the Cargo workspace for `repository_path`, or an empty one when the
/// folder is a Node, TypeScript, JavaScript, Go, PHP, Ruby, or .NET project
/// without a root `Cargo.toml`. The initial map and live refresh both use this,
/// so a project that opens also refreshes.
pub fn discover_project_workspace(
    repository_path: impl AsRef<Path>,
) -> Result<CargoWorkspace, MapExtractionError> {
    let requested = repository_path.as_ref();
    match discover_cargo_workspace(requested) {
        Ok(workspace) => Ok(workspace),
        Err(CargoDiscoveryError::ManifestMissing(manifest)) => {
            let root = manifest.parent().unwrap_or(requested);
            let marker = project_manifest(root);
            if marker
                .as_ref()
                .is_some_and(|path| path.file_name() != Some(OsStr::new("Cargo.toml")))
            {
                Ok(CargoWorkspace {
                    root: root.to_path_buf(),
                    packages: Vec::new(),
                })
            } else {
                Err(CargoDiscoveryError::ManifestMissing(manifest).into())
            }
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn map_workspace(
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

    let python_modules = discover_python_modules(&root_path)?;
    let go_packages = match discover_go_packages(&root_path) {
        Ok(packages) => packages,
        Err(CargoDiscoveryError::ManifestMissing(path))
            if path.file_name().and_then(|name| name.to_str()) == Some("go.mod") =>
        {
            Vec::new()
        }
        Err(error) => return Err(error.into()),
    };
    let php_packages = discover_php_packages(&root_path)?;
    let ruby_packages = discover_ruby_packages(&root_path)?;
    let typescript_modules = discover_typescript_modules(&root_path)?;
    let dotnet = discover_dotnet(&root_path)?;
    let cpp_targets = discover_cpp_targets(&root_path)?;
    let mut workspace_inputs: Vec<_> = crate_fingerprints
        .into_iter()
        .map(|(name, fingerprint)| format!("{name}:{fingerprint}"))
        .collect();
    for module in &python_modules {
        let fingerprint = fingerprints.file(&module.path)?;
        workspace_inputs.push(format!("python:{}:{fingerprint}", module.name));
    }
    for module in &typescript_modules {
        let fingerprint = fingerprints.file(&module.path)?;
        workspace_inputs.push(format!("web:{}:{fingerprint}", module.name));
    }
    for project in &dotnet.projects {
        let fingerprint = fingerprints.file(&project.path)?;
        workspace_inputs.push(format!("dotnet:{}:{fingerprint}", project.name));
    }
    for file in &dotnet.files {
        let fingerprint = fingerprints.file(&file.path)?;
        workspace_inputs.push(format!(
            "dotnet:{}:{fingerprint}",
            path_to_slashes(file.path.strip_prefix(&root_path).unwrap_or(&file.path))
        ));
    }
    for package in &go_packages {
        for file in &package.files {
            if let Ok(fingerprint) = fingerprints.file(&file.path) {
                workspace_inputs.push(format!(
                    "go:{}:{}:{fingerprint}",
                    package.import_path,
                    file.path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file")
                ));
            }
        }
    }
    for package in &php_packages {
        for file in &package.files {
            if let Ok(fingerprint) = fingerprints.file(&file.path) {
                workspace_inputs.push(format!(
                    "php:{}:{}:{fingerprint}",
                    package.import_path,
                    file.path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file")
                ));
            }
        }
    }
    for package in &ruby_packages {
        for file in &package.files {
            if let Ok(fingerprint) = fingerprints.file(&file.path) {
                workspace_inputs.push(format!(
                    "ruby:{}:{}:{fingerprint}",
                    package.import_path,
                    file.path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file")
                ));
            }
        }
    }
    for target in &cpp_targets {
        for file in &target.files {
            if let Ok(fingerprint) = fingerprints.file(&file.path) {
                workspace_inputs.push(format!(
                    "cpp:{}:{}:{fingerprint}",
                    target.name,
                    file.path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file")
                ));
            }
        }
    }
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
                source_path: Some(relative_path(
                    &root_path,
                    &project_manifest(&root_path).unwrap_or_else(|| root_path.join("Cargo.toml")),
                )),
                fingerprint: workspace_fingerprint,
            },
            member_count: workspace.packages.len(),
        }),
    );

    append_python_blocks(
        &python_modules,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_typescript_blocks(
        &typescript_modules,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_dotnet_blocks(
        &dotnet,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_go_blocks(
        &go_packages,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_php_blocks(
        &php_packages,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_ruby_blocks(
        &ruby_packages,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_cpp_blocks(
        &cpp_targets,
        &root_path,
        &project_id,
        &mut fingerprints,
        &mut blocks,
        &mut connections,
    )?;
    append_dependency_connections(&workspace, &package_id_by_manifest, &mut connections);
    derive_children(&mut blocks);

    let workspace_children = block_base(&blocks[0]).children.clone();
    let groups = vec![FactGroup {
        id: "group:crates".to_owned(),
        label: "Workspace crates".to_owned(),
        member_ids: workspace_children
            .into_iter()
            .filter(|id| id.starts_with("crate:"))
            .collect(),
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
            language: "rust".to_owned(),
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
            language: "rust".to_owned(),
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

fn append_typescript_blocks(
    modules: &[TypeScriptModule],
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    for module in modules {
        let id = typescript_block_id(&module.name, None);
        let relative = relative_path(root_path, &module.path);
        let fingerprint = fingerprints.file(&module.path)?;
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: id.clone(),
                label: module_label(&module.name),
                parent_id: Some(workspace_id.to_owned()),
                children: Vec::new(),
                source_path: Some(relative.clone()),
                fingerprint: fingerprint.clone(),
            },
            package_name: module.name.clone(),
            module_path: module.name.clone(),
            declared_by_path: relative,
            cfg_attributes: module
                .imports
                .iter()
                .map(|import| import.statement.clone())
                .collect(),
            unresolved: module.unreadable,
            language: module.language.clone(),
        }));
        connections.push(contains_connection(workspace_id, &id));
        for symbol in &module.symbols {
            append_typescript_symbol(&id, module, symbol, &fingerprint, blocks, connections);
        }
    }
    Ok(())
}

fn append_typescript_symbol(
    parent_id: &str,
    module: &TypeScriptModule,
    symbol: &TypeScriptSymbol,
    fingerprint: &str,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) {
    let module_path = format!("{}.{}", module.name, symbol.name);
    let id = typescript_block_id(&module_path, Some(symbol.outline_label()));
    let relative = blocks.iter().find_map(|block| match block {
        FactBlock::Module(parent) if parent.base.id == parent_id => parent.base.source_path.clone(),
        _ => None,
    });
    let declared = relative.clone().unwrap_or_default();
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: symbol.name.clone(),
            parent_id: Some(parent_id.to_owned()),
            children: Vec::new(),
            source_path: relative,
            fingerprint: fingerprint.to_owned(),
        },
        package_name: module.name.clone(),
        module_path,
        declared_by_path: declared,
        cfg_attributes: vec![symbol.outline_label().to_owned()],
        unresolved: false,
        language: module.language.clone(),
    }));
    connections.push(contains_connection(parent_id, &id));
}

fn typescript_block_id(module_path: &str, kind: Option<&str>) -> String {
    let mut id = format!("module:web:{}", slug(module_path));
    if let Some(kind) = kind {
        id.push(':');
        id.push_str(&slug(kind));
    }
    id
}

fn module_label(module_name: &str) -> String {
    module_name
        .rsplit('.')
        .next()
        .unwrap_or(module_name)
        .to_owned()
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

fn append_dotnet_blocks(
    dotnet: &DotnetWorkspace,
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    let mut seen = HashSet::new();
    let mut project_ids: HashMap<PathBuf, String> = HashMap::new();
    for project in &dotnet.projects {
        let relative = relative_path(root_path, &project.path);
        let id = dotnet_block_id("project", &[&relative]);
        let fingerprint = fingerprints.file(&project.path)?;
        push_dotnet_module(
            blocks,
            connections,
            &id,
            &project.name,
            workspace_id,
            &project.name,
            &project.name,
            &relative,
            vec!["project".to_owned()],
            false,
            &project.language,
            &relative,
            &fingerprint,
        );
        project_ids.insert(normalize_path(&project.path), id);
    }
    for project in &dotnet.projects {
        let Some(source_id) = project_ids.get(&normalize_path(&project.path)).cloned() else {
            continue;
        };
        for reference in &project.references {
            let Some(target) = dotnet
                .projects
                .iter()
                .find(|candidate| dotnet_paths_match(&candidate.path, reference))
            else {
                continue;
            };
            let Some(target_id) = project_ids.get(&normalize_path(&target.path)) else {
                continue;
            };
            if source_id == *target_id {
                continue;
            }
            push_depends(connections, &mut seen, &source_id, target_id);
        }
    }

    let mut namespace_ids: HashMap<(String, String), String> = HashMap::new();
    let mut file_ids: HashMap<PathBuf, String> = HashMap::new();
    for file in &dotnet.files {
        let relative = relative_path(root_path, &file.path);
        let fingerprint = fingerprints.file(&file.path)?;
        let project_key = file
            .project_path
            .as_ref()
            .map(|path| relative_path(root_path, path))
            .unwrap_or_default();
        let project_id = file
            .project_path
            .as_ref()
            .and_then(|path| project_ids.get(&normalize_path(path)).cloned());
        let namespace_id = if file.namespace.is_empty() {
            None
        } else {
            Some(ensure_dotnet_namespace(
                blocks,
                connections,
                &mut namespace_ids,
                &project_key,
                &file.namespace,
                project_id.as_deref().unwrap_or(workspace_id),
                &file.language,
                &relative,
                &fingerprint,
            ))
        };
        let parent = namespace_id
            .or(project_id)
            .unwrap_or_else(|| workspace_id.to_owned());
        let id = dotnet_block_id("file", &[&relative]);
        let label = file
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| relative.clone());
        let package_name = package_name_for(dotnet, file);
        let cfg = if file.imports.is_empty() {
            vec!["file".to_owned()]
        } else {
            file.imports
                .iter()
                .map(|item| item.statement.clone())
                .collect()
        };
        push_dotnet_module(
            blocks,
            connections,
            &id,
            &label,
            &parent,
            &package_name,
            &relative,
            &relative,
            cfg,
            file.unreadable,
            &file.language,
            &relative,
            &fingerprint,
        );
        file_ids.insert(normalize_path(&file.path), id);
    }

    struct TypeRec {
        id: String,
        qualified: String,
        simple: String,
        language: String,
        kind: DotnetSymbolKind,
        partial: bool,
        bases: Vec<String>,
        member_types: Vec<String>,
        files: Vec<PathBuf>,
        source: String,
        fingerprint: String,
        parent: String,
        package_name: String,
    }
    let mut types: HashMap<String, TypeRec> = HashMap::new();
    struct MethodRec {
        name: String,
        owner_key: String,
        line: usize,
        language: String,
        source: String,
        fingerprint: String,
        package_name: String,
    }
    let mut methods = Vec::new();
    for file in &dotnet.files {
        let relative = relative_path(root_path, &file.path);
        let fingerprint = fingerprints.file(&file.path)?;
        let project_key = file
            .project_path
            .as_ref()
            .map(|path| relative_path(root_path, path))
            .unwrap_or_default();
        let package_name = package_name_for(dotnet, file);
        let fallback = file_ids
            .get(&normalize_path(&file.path))
            .cloned()
            .unwrap_or_else(|| workspace_id.to_owned());
        for symbol in &file.symbols {
            let owner_key = format!(
                "{project_key}|{}",
                fold_key(&symbol.qualified, &file.language)
            );
            if symbol.kind == DotnetSymbolKind::Method {
                methods.push(MethodRec {
                    name: symbol.name.clone(),
                    owner_key,
                    line: symbol.line,
                    language: file.language.clone(),
                    source: relative.clone(),
                    fingerprint: fingerprint.clone(),
                    package_name: package_name.clone(),
                });
                continue;
            }
            let parent = namespace_ids
                .get(&(project_key.clone(), symbol.namespace.clone()))
                .cloned()
                .unwrap_or_else(|| fallback.clone());
            types
                .entry(owner_key)
                .and_modify(|record| {
                    record.partial = record.partial || symbol.partial;
                    record.bases.extend(symbol.bases.clone());
                    record.member_types.extend(symbol.member_types.clone());
                    record.files.push(file.path.clone());
                })
                .or_insert_with(|| TypeRec {
                    id: dotnet_block_id("type", &[&project_key, &symbol.qualified]),
                    qualified: symbol.qualified.clone(),
                    simple: symbol.name.clone(),
                    language: file.language.clone(),
                    kind: symbol.kind,
                    partial: symbol.partial,
                    bases: symbol.bases.clone(),
                    member_types: symbol.member_types.clone(),
                    files: vec![file.path.clone()],
                    source: relative.clone(),
                    fingerprint: fingerprint.clone(),
                    parent,
                    package_name: package_name.clone(),
                });
        }
    }

    let mut exact_types: HashMap<String, String> = HashMap::new();
    let mut folded_types: HashMap<String, Vec<String>> = HashMap::new();
    let mut simple_exact: HashMap<String, Vec<String>> = HashMap::new();
    let mut simple_folded: HashMap<String, Vec<String>> = HashMap::new();
    let mut ordered: Vec<_> = types.into_iter().collect();
    ordered.sort_by(|left, right| left.0.cmp(&right.0));
    let mut type_by_key: HashMap<String, TypeRec> = HashMap::new();
    for (key, record) in &ordered {
        exact_types.insert(record.qualified.clone(), record.id.clone());
        folded_types
            .entry(record.qualified.to_ascii_lowercase())
            .or_default()
            .push(record.id.clone());
        simple_exact
            .entry(record.simple.clone())
            .or_default()
            .push(record.id.clone());
        simple_folded
            .entry(record.simple.to_ascii_lowercase())
            .or_default()
            .push(record.id.clone());
        type_by_key.insert(
            key.clone(),
            TypeRec {
                id: record.id.clone(),
                qualified: record.qualified.clone(),
                simple: record.simple.clone(),
                language: record.language.clone(),
                kind: record.kind,
                partial: record.partial,
                bases: record.bases.clone(),
                member_types: record.member_types.clone(),
                files: record.files.clone(),
                source: record.source.clone(),
                fingerprint: record.fingerprint.clone(),
                parent: record.parent.clone(),
                package_name: record.package_name.clone(),
            },
        );
    }
    for (key, record) in ordered {
        let label = record
            .kind
            .cfg_label(record.partial || record.files.len() > 1);
        push_dotnet_module(
            blocks,
            connections,
            &record.id,
            &record.simple,
            &record.parent,
            &record.package_name,
            &record.qualified,
            &record.source,
            vec![label.to_owned()],
            false,
            &record.language,
            &record.source,
            &record.fingerprint,
        );
        for path in &record.files {
            if let Some(file_id) = file_ids.get(&normalize_path(path)) {
                let edge = format!("contains:{file_id}->{}", record.id);
                if file_id != &record.parent && seen.insert(edge) {
                    connections.push(contains_connection(file_id, &record.id));
                }
            }
        }
        let _ = key;
    }

    let mut method_ids = Vec::new();
    for method in &methods {
        let Some(owner) = type_by_key.get(&method.owner_key) else {
            continue;
        };
        let id = dotnet_block_id(
            "method",
            &[&owner.qualified, &method.name, &method.line.to_string()],
        );
        push_dotnet_module(
            blocks,
            connections,
            &id,
            &method.name,
            &owner.id,
            &method.package_name,
            &format!("{}.{}", owner.qualified, method.name),
            &method.source,
            vec!["method".to_owned()],
            false,
            &method.language,
            &method.source,
            &method.fingerprint,
        );
        method_ids.push((id, method));
    }

    let namespace_exact: HashMap<String, String> = namespace_ids
        .iter()
        .map(|((_, namespace), id)| (namespace.clone(), id.clone()))
        .collect();
    let namespace_folded: HashMap<String, String> = namespace_ids
        .iter()
        .map(|((_, namespace), id)| (namespace.to_ascii_lowercase(), id.clone()))
        .collect();

    for file in &dotnet.files {
        let Some(file_id) = file_ids.get(&normalize_path(&file.path)) else {
            continue;
        };
        let fold = file.language == "vb";
        let mut aliases = HashMap::new();
        let mut imports = Vec::new();
        for other in dotnet_imports_for(dotnet, file) {
            if let Some(alias) = &other.alias {
                aliases.insert(
                    if fold {
                        alias.to_ascii_lowercase()
                    } else {
                        alias.clone()
                    },
                    other.target.clone(),
                );
            }
            imports.push(other.target.clone());
            if let Some(target) = resolve_dotnet_name(
                &other.target,
                fold,
                &file.namespace,
                &[],
                &HashMap::new(),
                &exact_types,
                &folded_types,
                &simple_exact,
                &simple_folded,
                &namespace_exact,
                &namespace_folded,
            ) {
                if &target != file_id {
                    push_depends(connections, &mut seen, file_id, &target);
                }
            }
        }
        for symbol in &file.symbols {
            let source_id = if symbol.kind == DotnetSymbolKind::Method {
                method_ids
                    .iter()
                    .find(|(id, method)| {
                        let _ = id;
                        method.name == symbol.name
                            && method.line == symbol.line
                            && method.source == relative_path(root_path, &file.path)
                    })
                    .map(|(id, _)| id.clone())
            } else {
                let key = format!(
                    "{}|{}",
                    file.project_path
                        .as_ref()
                        .map(|path| relative_path(root_path, path))
                        .unwrap_or_default(),
                    fold_key(&symbol.qualified, &file.language)
                );
                type_by_key.get(&key).map(|record| record.id.clone())
            };
            let Some(source_id) = source_id else { continue };
            let mut names = symbol.bases.clone();
            names.extend(symbol.member_types.clone());
            for name in names {
                if let Some(target) = resolve_dotnet_name(
                    &name,
                    fold,
                    &symbol.namespace,
                    &imports,
                    &aliases,
                    &exact_types,
                    &folded_types,
                    &simple_exact,
                    &simple_folded,
                    &namespace_exact,
                    &namespace_folded,
                ) {
                    if target != source_id {
                        push_depends(connections, &mut seen, &source_id, &target);
                    }
                }
            }
        }
    }
    Ok(())
}

fn package_name_for(dotnet: &DotnetWorkspace, file: &DotnetFile) -> String {
    file.project_path
        .as_ref()
        .and_then(|path| {
            dotnet
                .projects
                .iter()
                .find(|project| dotnet_paths_match(&project.path, path))
                .map(|project| project.name.clone())
        })
        .unwrap_or_else(|| "dotnet".to_owned())
}

fn dotnet_imports_for<'a>(
    dotnet: &'a DotnetWorkspace,
    file: &'a DotnetFile,
) -> Vec<&'a DotnetImport> {
    let mut imports: Vec<&DotnetImport> = file.imports.iter().collect();
    for other in &dotnet.files {
        if !same_project(file, other) {
            continue;
        }
        for import in &other.imports {
            if import.global
                && !file
                    .imports
                    .iter()
                    .any(|item| item.statement == import.statement)
            {
                imports.push(import);
            }
        }
    }
    imports
}

fn same_project(left: &DotnetFile, right: &DotnetFile) -> bool {
    match (&left.project_path, &right.project_path) {
        (Some(left), Some(right)) => dotnet_paths_match(left, right),
        _ => false,
    }
}

fn ensure_dotnet_namespace(
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
    namespace_ids: &mut HashMap<(String, String), String>,
    project_key: &str,
    namespace: &str,
    parent: &str,
    language: &str,
    source: &str,
    fingerprint: &str,
) -> String {
    let key = (project_key.to_owned(), namespace.to_owned());
    if let Some(id) = namespace_ids.get(&key) {
        return id.clone();
    }
    let id = dotnet_block_id("namespace", &[project_key, namespace]);
    let label = namespace.rsplit('.').next().unwrap_or(namespace);
    push_dotnet_module(
        blocks,
        connections,
        &id,
        label,
        parent,
        namespace,
        namespace,
        source,
        vec!["namespace".to_owned()],
        false,
        language,
        source,
        fingerprint,
    );
    namespace_ids.insert(key, id.clone());
    id
}

fn fold_key(qualified: &str, language: &str) -> String {
    if language == "vb" {
        qualified.to_lowercase()
    } else {
        qualified.to_owned()
    }
}

fn dotnet_block_id(kind: &str, parts: &[&str]) -> String {
    let mut id = format!("module:dotnet:{kind}");
    for part in parts {
        id.push(':');
        let slugged = slug(part);
        if slugged.is_empty() {
            id.push_str("global");
        } else {
            id.push_str(&slugged);
        }
    }
    id
}

fn push_dotnet_module(
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
    id: &str,
    label: &str,
    parent: &str,
    package_name: &str,
    module_path: &str,
    declared_by: &str,
    cfg_attributes: Vec<String>,
    unresolved: bool,
    language: &str,
    source: &str,
    fingerprint: &str,
) {
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.to_owned(),
            label: label.to_owned(),
            parent_id: Some(parent.to_owned()),
            children: Vec::new(),
            source_path: Some(source.to_owned()),
            fingerprint: fingerprint.to_owned(),
        },
        package_name: package_name.to_owned(),
        module_path: module_path.to_owned(),
        declared_by_path: declared_by.to_owned(),
        cfg_attributes,
        unresolved,
        language: language.to_owned(),
    }));
    connections.push(contains_connection(parent, id));
}

fn push_depends(
    connections: &mut Vec<Connection>,
    seen: &mut HashSet<String>,
    source: &str,
    target: &str,
) {
    let id = connection_id("depends_on", source, target);
    if seen.insert(id.clone()) {
        connections.push(Connection::DependsOn {
            id,
            source: source.to_owned(),
            target: target.to_owned(),
            dependency_scope: DependencyScope::Normal,
        });
    }
}

fn dotnet_paths_match(left: &Path, right: &Path) -> bool {
    let left = normalize_path(left);
    let right = normalize_path(right);
    if left == right {
        return true;
    }
    left.file_name() == right.file_name()
        && left.parent().and_then(|path| path.file_name())
            == right.parent().and_then(|path| path.file_name())
}

fn resolve_dotnet_name(
    raw: &str,
    fold: bool,
    namespace: &str,
    imports: &[String],
    aliases: &HashMap<String, String>,
    exact_types: &HashMap<String, String>,
    folded_types: &HashMap<String, Vec<String>>,
    simple_exact: &HashMap<String, Vec<String>>,
    simple_folded: &HashMap<String, Vec<String>>,
    namespace_exact: &HashMap<String, String>,
    namespace_folded: &HashMap<String, String>,
) -> Option<String> {
    let mut name = raw
        .trim()
        .trim_start_matches("global::")
        .trim_end_matches('?')
        .to_owned();
    if name.is_empty() || is_dotnet_primitive(&name) {
        return None;
    }
    let alias_key = if fold {
        name.to_ascii_lowercase()
    } else {
        name.clone()
    };
    if let Some(target) = aliases.get(&alias_key) {
        name = target.clone();
    } else if let Some((head, tail)) = name.split_once('.') {
        let head_key = if fold {
            head.to_ascii_lowercase()
        } else {
            head.to_owned()
        };
        if let Some(target) = aliases.get(&head_key) {
            name = format!("{target}.{tail}");
        }
    }
    if let Some(found) = lookup_qualified(
        &name,
        fold,
        exact_types,
        folded_types,
        namespace_exact,
        namespace_folded,
    ) {
        return Some(found);
    }
    if !name.contains('.') {
        let qualified = if namespace.is_empty() {
            name.clone()
        } else {
            format!("{namespace}.{name}")
        };
        if let Some(found) = lookup_qualified(
            &qualified,
            fold,
            exact_types,
            folded_types,
            namespace_exact,
            namespace_folded,
        ) {
            return Some(found);
        }
        for import in imports {
            let candidate = format!("{import}.{name}");
            if let Some(found) = lookup_qualified(
                &candidate,
                fold,
                exact_types,
                folded_types,
                namespace_exact,
                namespace_folded,
            ) {
                return Some(found);
            }
        }
        let simple = if fold {
            unique(simple_folded.get(&name.to_ascii_lowercase()))
        } else {
            unique(simple_exact.get(&name))
        };
        if simple.is_some() {
            return simple;
        }
    }
    None
}

fn lookup_qualified(
    name: &str,
    fold: bool,
    exact_types: &HashMap<String, String>,
    folded_types: &HashMap<String, Vec<String>>,
    namespace_exact: &HashMap<String, String>,
    namespace_folded: &HashMap<String, String>,
) -> Option<String> {
    if fold {
        unique(folded_types.get(&name.to_ascii_lowercase()))
            .or_else(|| namespace_folded.get(&name.to_ascii_lowercase()).cloned())
    } else {
        exact_types
            .get(name)
            .cloned()
            .or_else(|| namespace_exact.get(name).cloned())
    }
}

fn unique(values: Option<&Vec<String>>) -> Option<String> {
    let values = values?;
    if values.len() == 1 {
        values.first().cloned()
    } else {
        None
    }
}

fn is_dotnet_primitive(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "void"
            | "int"
            | "string"
            | "bool"
            | "boolean"
            | "byte"
            | "char"
            | "decimal"
            | "double"
            | "float"
            | "long"
            | "short"
            | "object"
            | "uint"
            | "ulong"
            | "ushort"
            | "nint"
            | "nuint"
            | "dynamic"
            | "var"
            | "integer"
            | "single"
            | "date"
            | "datetime"
    )
}

fn append_go_blocks(
    packages: &[GoPackage],
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    let package_ids: HashMap<String, String> = packages
        .iter()
        .map(|package| {
            (
                package.import_path.clone(),
                go_package_block_id(&package.import_path),
            )
        })
        .collect();
    for package in packages {
        let package_id = package_ids[&package.import_path].clone();
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: package_id.clone(),
                label: package.name.clone(),
                parent_id: Some(workspace_id.to_owned()),
                children: Vec::new(),
                source_path: package
                    .files
                    .first()
                    .map(|file| relative_path(root_path, &file.path)),
                fingerprint: package_fingerprint(package, fingerprints)?,
            },
            package_name: package.import_path.clone(),
            module_path: package.import_path.clone(),
            declared_by_path: relative_path(root_path, &package.directory),
            cfg_attributes: package
                .files
                .iter()
                .flat_map(|file| file.imports.iter().map(|import| import.statement()))
                .collect(),
            unresolved: package.files.iter().all(|file| file.unreadable),
            language: "go".to_owned(),
        }));
        connections.push(contains_connection(workspace_id, &package_id));
        for file in &package.files {
            append_go_file(
                &package_id,
                package,
                file,
                root_path,
                fingerprints,
                blocks,
                connections,
            )?;
        }
        let mut import_edges = HashSet::new();
        for file in &package.files {
            for import in &file.imports {
                if let Some(target) = package_ids.get(&import.path) {
                    if target != &package_id {
                        let id = connection_id("depends_on", &package_id, target);
                        if import_edges.insert(id.clone()) {
                            connections.push(Connection::DependsOn {
                                id,
                                source: package_id.clone(),
                                target: target.clone(),
                                dependency_scope: DependencyScope::Normal,
                            });
                        }
                    }
                }
            }
        }
    }
    append_go_call_connections(packages, blocks, connections);
    Ok(())
}

fn append_go_call_connections(
    packages: &[GoPackage],
    blocks: &[FactBlock],
    connections: &mut Vec<Connection>,
) {
    let mut symbol_ids: HashMap<(String, String), String> = HashMap::new();
    for block in blocks {
        let FactBlock::Module(module) = block else {
            continue;
        };
        if module.language != "go" || module.cfg_attributes.len() != 1 {
            continue;
        }
        let kind = module.cfg_attributes[0].as_str();
        if kind != "func" && kind != "method" && kind != "type" {
            continue;
        }
        symbol_ids.insert(
            (module.package_name.clone(), module.base.label.clone()),
            module.base.id.clone(),
        );
    }
    let mut call_edges = HashSet::new();
    for package in packages {
        for file in &package.files {
            if file.unreadable {
                continue;
            }
            let stem = file
                .path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("file");
            let module_path = format!("{}/{}", package.import_path, stem);
            let file_id = go_file_block_id(&module_path, file.test);
            let aliases = go_import_alias_paths(&file.imports);
            for call in &file.calls {
                let import_path = match aliases.get(&call.qualifier) {
                    Some(path) => path,
                    None => continue,
                };
                let target_id = match symbol_ids.get(&(import_path.clone(), call.name.clone())) {
                    Some(id) => id,
                    None => continue,
                };
                let id = connection_id("depends_on", &file_id, target_id);
                if call_edges.insert(id.clone()) {
                    connections.push(Connection::DependsOn {
                        id,
                        source: file_id.clone(),
                        target: target_id.clone(),
                        dependency_scope: DependencyScope::Normal,
                    });
                }
            }
        }
    }
}

fn package_fingerprint(
    package: &GoPackage,
    fingerprints: &mut FileFingerprints,
) -> Result<String, MapExtractionError> {
    let mut parts = Vec::new();
    for file in &package.files {
        parts.push(fingerprints.file(&file.path)?);
    }
    parts.sort();
    Ok(hash_text(&parts.join("\n")))
}

fn append_go_file(
    package_id: &str,
    package: &GoPackage,
    file: &GoFile,
    root_path: &Path,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    let stem = file
        .path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let module_path = format!("{}/{}", package.import_path, stem);
    let id = go_file_block_id(&module_path, file.test);
    let relative = relative_path(root_path, &file.path);
    let fingerprint = fingerprints.file(&file.path)?;
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: stem.to_owned(),
            parent_id: Some(package_id.to_owned()),
            children: Vec::new(),
            source_path: Some(relative.clone()),
            fingerprint: fingerprint.clone(),
        },
        package_name: package.import_path.clone(),
        module_path: module_path.clone(),
        declared_by_path: relative,
        cfg_attributes: file
            .imports
            .iter()
            .map(|import| import.statement())
            .collect(),
        unresolved: file.unreadable,
        language: "go".to_owned(),
    }));
    connections.push(contains_connection(package_id, &id));
    for symbol in &file.symbols {
        append_go_symbol(
            &id,
            package,
            file,
            symbol,
            &fingerprint,
            blocks,
            connections,
        );
    }
    Ok(())
}

fn append_go_symbol(
    parent_id: &str,
    package: &GoPackage,
    file: &GoFile,
    symbol: &GoSymbol,
    fingerprint: &str,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) {
    let stem = file
        .path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let module_path = format!("{}/{}.{}", package.import_path, stem, symbol.name);
    let id = go_symbol_block_id(&module_path, symbol.outline_label());
    let relative = blocks.iter().find_map(|block| match block {
        FactBlock::Module(parent) if parent.base.id == parent_id => parent.base.source_path.clone(),
        _ => None,
    });
    let declared = relative.clone().unwrap_or_default();
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: symbol.name.clone(),
            parent_id: Some(parent_id.to_owned()),
            children: Vec::new(),
            source_path: relative,
            fingerprint: fingerprint.to_owned(),
        },
        package_name: package.import_path.clone(),
        module_path,
        declared_by_path: declared,
        cfg_attributes: vec![symbol.outline_label().to_owned()],
        unresolved: false,
        language: "go".to_owned(),
    }));
    connections.push(contains_connection(parent_id, &id));
}

fn go_package_block_id(import_path: &str) -> String {
    format!("module:go:{}", slug(import_path))
}

fn go_file_block_id(module_path: &str, test: bool) -> String {
    let mut id = format!("module:go:{}", slug(module_path));
    if test {
        id.push_str(":test");
    }
    id
}

fn go_symbol_block_id(module_path: &str, kind: &str) -> String {
    format!("module:go:{}:{}", slug(module_path), slug(kind))
}

fn append_php_blocks(
    packages: &[PhpPackage],
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    let mut symbol_ids: HashMap<String, String> = HashMap::new();
    let mut namespace_ids: HashMap<String, String> = HashMap::new();
    for package in packages {
        let package_id = php_package_block_id(&package.import_path);
        if !package.namespace.is_empty() {
            namespace_ids.insert(package.namespace.clone(), package_id.clone());
        }
        let relative_dir = relative_path(root_path, &package.directory);
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: package_id.clone(),
                label: package.name.clone(),
                parent_id: Some(workspace_id.to_owned()),
                children: Vec::new(),
                source_path: package
                    .files
                    .first()
                    .map(|file| relative_path(root_path, &file.path)),
                fingerprint: content_fingerprint(
                    package.files.iter().map(|file| file.path.as_path()),
                    fingerprints,
                )?,
            },
            package_name: package.composer_name.clone(),
            module_path: package.import_path.clone(),
            declared_by_path: relative_dir,
            cfg_attributes: package
                .files
                .iter()
                .flat_map(|file| file.imports.iter().map(|import| import.statement.clone()))
                .collect(),
            unresolved: !package.files.is_empty()
                && package.files.iter().all(|file| file.unreadable),
            language: "php".to_owned(),
        }));
        connections.push(contains_connection(workspace_id, &package_id));
        for file in &package.files {
            append_php_file(
                &package_id,
                package,
                file,
                root_path,
                fingerprints,
                blocks,
                connections,
                &mut symbol_ids,
            )?;
        }
    }
    append_php_import_edges(packages, &symbol_ids, &namespace_ids, connections);
    Ok(())
}

fn append_php_file(
    package_id: &str,
    package: &PhpPackage,
    file: &PhpFile,
    root_path: &Path,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
    symbol_ids: &mut HashMap<String, String>,
) -> Result<(), MapExtractionError> {
    let stem = file
        .path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let module_path = format!("{}/{stem}", package.import_path);
    let id = php_file_block_id(&module_path);
    let relative = relative_path(root_path, &file.path);
    let fingerprint = fingerprints.file(&file.path)?;
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: stem.to_owned(),
            parent_id: Some(package_id.to_owned()),
            children: Vec::new(),
            source_path: Some(relative.clone()),
            fingerprint: fingerprint.clone(),
        },
        package_name: package.composer_name.clone(),
        module_path: module_path.clone(),
        declared_by_path: relative.clone(),
        cfg_attributes: file
            .imports
            .iter()
            .map(|import| import.statement.clone())
            .collect(),
        unresolved: file.unreadable,
        language: "php".to_owned(),
    }));
    connections.push(contains_connection(package_id, &id));
    for symbol in &file.symbols {
        let symbol_module = format!("{module_path}.{}", symbol.name);
        let symbol_id = php_symbol_block_id(&symbol_module, symbol.outline_label());
        let qualified = if package.namespace.is_empty() {
            symbol.name.clone()
        } else {
            format!("{}\\{}", package.namespace, symbol.name)
        };
        symbol_ids.insert(qualified, symbol_id.clone());
        append_php_symbol(
            &id,
            package,
            symbol,
            &symbol_module,
            &relative,
            &fingerprint,
            blocks,
            connections,
        );
    }
    Ok(())
}

fn append_php_symbol(
    parent_id: &str,
    package: &PhpPackage,
    symbol: &PhpSymbol,
    module_path: &str,
    relative: &str,
    fingerprint: &str,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) {
    let id = php_symbol_block_id(module_path, symbol.outline_label());
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: symbol.name.clone(),
            parent_id: Some(parent_id.to_owned()),
            children: Vec::new(),
            source_path: Some(relative.to_owned()),
            fingerprint: fingerprint.to_owned(),
        },
        package_name: package.composer_name.clone(),
        module_path: module_path.to_owned(),
        declared_by_path: relative.to_owned(),
        cfg_attributes: vec![symbol.outline_label().to_owned()],
        unresolved: false,
        language: "php".to_owned(),
    }));
    connections.push(contains_connection(parent_id, &id));
}

fn append_php_import_edges(
    packages: &[PhpPackage],
    symbol_ids: &HashMap<String, String>,
    namespace_ids: &HashMap<String, String>,
    connections: &mut Vec<Connection>,
) {
    let mut edges = HashSet::new();
    for package in packages {
        let package_id = php_package_block_id(&package.import_path);
        for file in &package.files {
            if file.unreadable {
                continue;
            }
            let stem = file
                .path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("file");
            let file_id = php_file_block_id(&format!("{}/{stem}", package.import_path));
            for import in &file.imports {
                if let Some(target) = symbol_ids.get(&import.qualified) {
                    if target != &file_id {
                        push_depends(connections, &mut edges, &file_id, target);
                    }
                }
                if let Some((parent, _)) = import.qualified.rsplit_once('\\') {
                    if let Some(target) = namespace_ids.get(parent) {
                        if target != &package_id {
                            push_depends(connections, &mut edges, &package_id, target);
                        }
                    }
                }
                if let Some(target) = namespace_ids.get(&import.qualified) {
                    if target != &package_id {
                        push_depends(connections, &mut edges, &package_id, target);
                    }
                }
            }
        }
    }
}

fn append_ruby_blocks(
    packages: &[RubyPackage],
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    let mut file_ids: HashMap<PathBuf, String> = HashMap::new();
    for package in packages {
        let package_id = ruby_package_block_id(&package.import_path);
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: package_id.clone(),
                label: package.name.clone(),
                parent_id: Some(workspace_id.to_owned()),
                children: Vec::new(),
                source_path: package
                    .files
                    .first()
                    .map(|file| relative_path(root_path, &file.path)),
                fingerprint: content_fingerprint(
                    package.files.iter().map(|file| file.path.as_path()),
                    fingerprints,
                )?,
            },
            package_name: package.gem_name.clone(),
            module_path: package.import_path.clone(),
            declared_by_path: relative_path(root_path, &package.directory),
            cfg_attributes: package
                .files
                .iter()
                .flat_map(|file| file.imports.iter().map(|import| import.statement.clone()))
                .collect(),
            unresolved: !package.files.is_empty()
                && package.files.iter().all(|file| file.unreadable),
            language: "ruby".to_owned(),
        }));
        connections.push(contains_connection(workspace_id, &package_id));
        for file in &package.files {
            let file_id = append_ruby_file(
                &package_id,
                package,
                file,
                root_path,
                fingerprints,
                blocks,
                connections,
            )?;
            if let Ok(canonical) = file.path.canonicalize() {
                file_ids.insert(canonical, file_id);
            }
        }
    }
    append_ruby_require_edges(packages, root_path, &file_ids, connections);
    Ok(())
}

fn append_ruby_file(
    package_id: &str,
    package: &RubyPackage,
    file: &RubyFile,
    root_path: &Path,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<String, MapExtractionError> {
    let module_path = format!("{}/{}", package.import_path, file.module_suffix);
    let id = ruby_file_block_id(&module_path);
    let relative = relative_path(root_path, &file.path);
    let fingerprint = fingerprints.file(&file.path)?;
    let label = file
        .module_suffix
        .rsplit('/')
        .next()
        .unwrap_or(&file.module_suffix)
        .to_owned();
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label,
            parent_id: Some(package_id.to_owned()),
            children: Vec::new(),
            source_path: Some(relative.clone()),
            fingerprint: fingerprint.clone(),
        },
        package_name: package.gem_name.clone(),
        module_path: module_path.clone(),
        declared_by_path: relative.clone(),
        cfg_attributes: file
            .imports
            .iter()
            .map(|import| import.statement.clone())
            .collect(),
        unresolved: file.unreadable,
        language: "ruby".to_owned(),
    }));
    connections.push(contains_connection(package_id, &id));
    for symbol in &file.symbols {
        append_ruby_symbol(
            &id,
            package,
            symbol,
            &format!("{module_path}.{}", symbol.name),
            &relative,
            &fingerprint,
            blocks,
            connections,
        );
    }
    Ok(id)
}

fn append_ruby_symbol(
    parent_id: &str,
    package: &RubyPackage,
    symbol: &RubySymbol,
    module_path: &str,
    relative: &str,
    fingerprint: &str,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) {
    let id = ruby_symbol_block_id(module_path, symbol.outline_label());
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: symbol.name.clone(),
            parent_id: Some(parent_id.to_owned()),
            children: Vec::new(),
            source_path: Some(relative.to_owned()),
            fingerprint: fingerprint.to_owned(),
        },
        package_name: package.gem_name.clone(),
        module_path: module_path.to_owned(),
        declared_by_path: relative.to_owned(),
        cfg_attributes: vec![symbol.outline_label().to_owned()],
        unresolved: false,
        language: "ruby".to_owned(),
    }));
    connections.push(contains_connection(parent_id, &id));
}

fn append_ruby_require_edges(
    packages: &[RubyPackage],
    root_path: &Path,
    file_ids: &HashMap<PathBuf, String>,
    connections: &mut Vec<Connection>,
) {
    let mut edges = HashSet::new();
    for package in packages {
        for file in &package.files {
            if file.unreadable {
                continue;
            }
            let module_path = format!("{}/{}", package.import_path, file.module_suffix);
            let file_id = ruby_file_block_id(&module_path);
            for import in &file.imports {
                let Some(resolved) = resolve_ruby_require(root_path, &file.path, import) else {
                    continue;
                };
                let Some(target) = file_ids.get(&resolved) else {
                    continue;
                };
                if target != &file_id {
                    push_depends(connections, &mut edges, &file_id, target);
                }
            }
        }
    }
}

fn content_fingerprint<'a>(
    paths: impl Iterator<Item = &'a Path>,
    fingerprints: &mut FileFingerprints,
) -> Result<String, MapExtractionError> {
    let mut parts = Vec::new();
    for path in paths {
        parts.push(fingerprints.file(path)?);
    }
    parts.sort();
    Ok(hash_text(&parts.join("\n")))
}

fn php_package_block_id(import_path: &str) -> String {
    format!("module:php:{}", language_id_encode(import_path))
}

fn php_file_block_id(module_path: &str) -> String {
    format!("module:php:{}", language_id_encode(module_path))
}

fn php_symbol_block_id(module_path: &str, kind: &str) -> String {
    format!(
        "module:php:{}:{}",
        language_id_encode(module_path),
        language_id_encode(kind)
    )
}

fn ruby_package_block_id(import_path: &str) -> String {
    format!("module:ruby:{}", language_id_encode(import_path))
}

fn ruby_file_block_id(module_path: &str) -> String {
    format!("module:ruby:{}", language_id_encode(module_path))
}

fn ruby_symbol_block_id(module_path: &str, kind: &str) -> String {
    format!(
        "module:ruby:{}:{}",
        language_id_encode(module_path),
        language_id_encode(kind)
    )
}

/// Injective path/name encoding for language-pack block ids (`foo-bar` ≠ `foo_bar`, `Foo` ≠ `foo`).
pub(crate) fn language_id_encode(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character);
        } else {
            out.push_str(&format!("_{:x}_", character as u32));
        }
    }
    out
}

fn append_cpp_blocks(
    targets: &[CppTarget],
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    let mut file_ids: HashMap<PathBuf, String> = HashMap::new();
    for target in targets {
        let target_id = cpp_target_block_id(&target.name);
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: target_id.clone(),
                label: target.name.clone(),
                parent_id: Some(workspace_id.to_owned()),
                children: Vec::new(),
                source_path: Some(relative_path(root_path, &target.directory)),
                fingerprint: cpp_target_fingerprint(target, fingerprints)?,
            },
            package_name: target.name.clone(),
            module_path: target.name.clone(),
            declared_by_path: relative_path(root_path, &target.directory),
            cfg_attributes: vec![target.kind.outline_label().to_owned()],
            unresolved: target.files.iter().all(|file| file.unreadable),
            language: "cpp".to_owned(),
        }));
        connections.push(contains_connection(workspace_id, &target_id));
        for file in &target.files {
            let file_id = append_cpp_file(
                &target_id,
                target,
                file,
                root_path,
                fingerprints,
                blocks,
                connections,
            )?;
            file_ids.insert(normalize_path(&file.path), file_id);
        }
    }
    append_cpp_include_connections(targets, root_path, &file_ids, connections);
    Ok(())
}

fn cpp_target_fingerprint(
    target: &CppTarget,
    fingerprints: &mut FileFingerprints,
) -> Result<String, MapExtractionError> {
    let mut parts = Vec::new();
    for file in &target.files {
        parts.push(fingerprints.file(&file.path)?);
    }
    parts.sort();
    Ok(hash_text(&parts.join("\n")))
}

fn append_cpp_file(
    target_id: &str,
    target: &CppTarget,
    file: &CppFile,
    root_path: &Path,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<String, MapExtractionError> {
    let relative = relative_path(root_path, &file.path);
    let without_ext = strip_source_extension(&relative);
    let module_path = format!("{}/{}", target.name, without_ext);
    let id = cpp_file_block_id(&module_path);
    let fingerprint = fingerprints.file(&file.path)?;
    let label = Path::new(&relative)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_owned();
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label,
            parent_id: Some(target_id.to_owned()),
            children: Vec::new(),
            source_path: Some(relative.clone()),
            fingerprint: fingerprint.clone(),
        },
        package_name: target.name.clone(),
        module_path: module_path.clone(),
        declared_by_path: relative,
        cfg_attributes: file
            .includes
            .iter()
            .map(|include| include.statement())
            .collect(),
        unresolved: file.unreadable,
        language: "cpp".to_owned(),
    }));
    connections.push(contains_connection(target_id, &id));
    for symbol in &file.symbols {
        append_cpp_symbol(
            &id,
            target,
            &module_path,
            symbol,
            &fingerprint,
            blocks,
            connections,
        );
    }
    Ok(id)
}

fn append_cpp_symbol(
    parent_id: &str,
    target: &CppTarget,
    file_module_path: &str,
    symbol: &CppSymbol,
    fingerprint: &str,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) {
    let module_path = format!("{}.{}", file_module_path, symbol.name);
    let id = cpp_symbol_block_id(&module_path, symbol.outline_label());
    let relative = blocks.iter().find_map(|block| match block {
        FactBlock::Module(parent) if parent.base.id == parent_id => parent.base.source_path.clone(),
        _ => None,
    });
    let declared = relative.clone().unwrap_or_default();
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: symbol.name.clone(),
            parent_id: Some(parent_id.to_owned()),
            children: Vec::new(),
            source_path: relative,
            fingerprint: fingerprint.to_owned(),
        },
        package_name: target.name.clone(),
        module_path,
        declared_by_path: declared,
        cfg_attributes: vec![symbol.outline_label().to_owned()],
        unresolved: false,
        language: "cpp".to_owned(),
    }));
    connections.push(contains_connection(parent_id, &id));
}

fn append_cpp_include_connections(
    targets: &[CppTarget],
    root_path: &Path,
    file_ids: &HashMap<PathBuf, String>,
    connections: &mut Vec<Connection>,
) {
    let mut edges = HashSet::new();
    for target in targets {
        for file in &target.files {
            if file.unreadable {
                continue;
            }
            let Some(source_id) = file_ids.get(&normalize_path(&file.path)) else {
                continue;
            };
            let parent = file.path.parent().unwrap_or(root_path);
            for include in &file.includes {
                if include.system {
                    continue;
                }
                let candidates = [
                    normalize_path(&parent.join(&include.path)),
                    normalize_path(&root_path.join(&include.path)),
                ];
                for candidate in candidates {
                    if let Some(target_id) = file_ids.get(&candidate) {
                        if target_id != source_id {
                            let id = connection_id("depends_on", source_id, target_id);
                            if edges.insert(id.clone()) {
                                connections.push(Connection::DependsOn {
                                    id,
                                    source: source_id.clone(),
                                    target: target_id.clone(),
                                    dependency_scope: DependencyScope::Normal,
                                });
                            }
                        }
                        break;
                    }
                }
            }
        }
    }
}

fn strip_source_extension(relative: &str) -> String {
    let path = Path::new(relative);
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext)
            if matches!(
                ext.to_ascii_lowercase().as_str(),
                "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx"
            ) =>
        {
            path.with_extension("").to_string_lossy().replace('\\', "/")
        }
        _ => relative.replace('\\', "/"),
    }
}

fn cpp_target_block_id(name: &str) -> String {
    format!("module:cpp:{}", slug(name))
}

fn cpp_file_block_id(module_path: &str) -> String {
    format!("module:cpp:{}", slug(module_path))
}

fn cpp_symbol_block_id(module_path: &str, kind: &str) -> String {
    format!("module:cpp:{}:{}", slug(module_path), slug(kind))
}

fn append_python_blocks(
    modules: &[PythonModule],
    root_path: &Path,
    workspace_id: &str,
    fingerprints: &mut FileFingerprints,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) -> Result<(), MapExtractionError> {
    for module in modules {
        let id = python_block_id(&module.name, module.stub, None);
        let relative = relative_path(root_path, &module.path);
        let fingerprint = fingerprints.file(&module.path)?;
        blocks.push(FactBlock::Module(ModuleBlock {
            base: BlockBase {
                id: id.clone(),
                label: module_label(&module.name),
                parent_id: Some(workspace_id.to_owned()),
                children: Vec::new(),
                source_path: Some(relative.clone()),
                fingerprint: fingerprint.clone(),
            },
            package_name: module
                .package
                .clone()
                .unwrap_or_else(|| module.name.clone()),
            module_path: module.name.clone(),
            declared_by_path: relative,
            cfg_attributes: module
                .imports
                .iter()
                .map(|import| import.statement())
                .collect(),
            unresolved: module.unreadable,
            language: "python".to_owned(),
        }));
        connections.push(contains_connection(workspace_id, &id));
        for symbol in &module.symbols {
            append_python_symbol(&id, module, symbol, &fingerprint, blocks, connections);
        }
    }
    Ok(())
}

fn append_python_symbol(
    parent_id: &str,
    module: &PythonModule,
    symbol: &PythonSymbol,
    fingerprint: &str,
    blocks: &mut Vec<FactBlock>,
    connections: &mut Vec<Connection>,
) {
    let module_path = format!("{}.{}", module.name, symbol.name);
    let id = python_block_id(&module_path, module.stub, Some(symbol.outline_label()));
    let relative = blocks.iter().find_map(|block| match block {
        FactBlock::Module(parent) if parent.base.id == parent_id => parent.base.source_path.clone(),
        _ => None,
    });
    let declared = relative.clone().unwrap_or_default();
    blocks.push(FactBlock::Module(ModuleBlock {
        base: BlockBase {
            id: id.clone(),
            label: symbol.name.clone(),
            parent_id: Some(parent_id.to_owned()),
            children: Vec::new(),
            source_path: relative,
            fingerprint: fingerprint.to_owned(),
        },
        package_name: module
            .package
            .clone()
            .unwrap_or_else(|| module.name.clone()),
        module_path,
        declared_by_path: declared,
        cfg_attributes: vec![symbol.outline_label().to_owned()],
        unresolved: false,
        language: "python".to_owned(),
    }));
    connections.push(contains_connection(parent_id, &id));
}

fn python_block_id(module_path: &str, stub: bool, kind: Option<&str>) -> String {
    let mut id = format!("module:python:{}", slug(module_path));
    if stub {
        id.push_str(":stub");
    }
    if let Some(kind) = kind {
        id.push(':');
        id.push_str(&slug(kind));
    }
    id
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
        if character.is_alphanumeric() {
            for lower in character.to_lowercase() {
                slug.push(lower);
            }
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

pub(crate) fn block_base(block: &FactBlock) -> &BlockBase {
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

#[cfg(test)]
mod tests {
    use super::extract_cargo_map;
    use crate::facts::FactBlock;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lightwell-extract-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn a_react_typescript_project_extracts_without_cargo_toml() {
        let root = temporary_directory("react");
        fs::create_dir_all(root.join("src")).expect("source folder should be created");
        fs::write(root.join("package.json"), "{\n  \"name\": \"demo\"\n}\n")
            .expect("package.json should be written");
        fs::write(root.join("tsconfig.json"), "{}\n").expect("tsconfig.json should be written");
        fs::write(
            root.join("src/App.tsx"),
            "export function App() {\n  return null;\n}\n",
        )
        .expect("App.tsx should be written");

        let map = extract_cargo_map(&root, Some("Demo")).expect("a Node project should extract");
        assert_eq!(map.project.name, "Demo");
        assert_eq!(map.stats.crates, 0);
        assert!(map.blocks.iter().any(|block| matches!(
            block,
            FactBlock::Workspace(workspace) if workspace.base.source_path.as_deref() == Some("package.json")
        )));
        assert!(map.blocks.iter().any(|block| matches!(
            block,
            FactBlock::Module(module) if module.module_path == "src.App" && module.language == "typescript"
        )));

        let empty = temporary_directory("empty");
        fs::create_dir_all(&empty).expect("empty folder should be created");
        let error = extract_cargo_map(&empty, None)
            .expect_err("a folder with no manifest should stay an error")
            .to_string();
        assert!(
            error.contains("Cargo.toml"),
            "missing-manifest error should name Cargo.toml: {error}"
        );
        fs::remove_dir_all(root).expect("react fixture should be removed");
        fs::remove_dir_all(empty).expect("empty fixture should be removed");
    }
}
