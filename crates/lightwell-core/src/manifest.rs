use crate::metadata::{
    CargoDependency, CargoDependencyKind, CargoDiscoveryError, CargoPackage, CargoTarget,
    CargoWorkspace,
};
use glob::glob;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use toml::Value;

pub(super) fn discover_cargo_workspace(
    requested_root: &Path,
) -> Result<CargoWorkspace, CargoDiscoveryError> {
    let requested_manifest = requested_root.join("Cargo.toml");
    let requested_document = read_manifest(&requested_manifest)?;
    let (workspace_root, workspace_document) =
        find_workspace_root(requested_root, &requested_document)?;
    let workspace_manifest = workspace_root.join("Cargo.toml");
    let workspace_package = table(&workspace_document, "workspace", &workspace_manifest)?
        .and_then(|workspace| workspace.get("package"))
        .and_then(Value::as_table);
    let (package_directories, excluded_directories) = member_directories(
        &workspace_root,
        &workspace_document,
        requested_root,
        &requested_document,
    )?;

    let mut packages = Vec::new();
    let mut pending: BTreeSet<_> = package_directories.into_iter().collect();
    let mut visited = BTreeSet::new();
    while let Some(package_directory) = pending.pop_first() {
        if !visited.insert(package_directory.clone()) {
            continue;
        }
        let manifest_path = package_directory.join("Cargo.toml");
        let document = if manifest_path == requested_manifest {
            requested_document.clone()
        } else if manifest_path == workspace_manifest {
            workspace_document.clone()
        } else {
            read_manifest(&manifest_path)?
        };
        if let Some(package) = parse_package(
            &manifest_path,
            &document,
            workspace_package,
            &workspace_document,
            &workspace_root,
        )? {
            for dependency in &package.dependencies {
                let Some(dependency_path) = &dependency.path else {
                    continue;
                };
                if !dependency_path.starts_with(&workspace_root)
                    || excluded_directories
                        .iter()
                        .any(|excluded| dependency_path.starts_with(excluded))
                    || !dependency_path.join("Cargo.toml").is_file()
                {
                    continue;
                }
                pending.insert(dependency_path.clone());
            }
            packages.push(package);
        }
    }
    packages.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.manifest_path.cmp(&right.manifest_path))
    });

    let mut workspace = CargoWorkspace {
        root: workspace_root,
        packages,
    };
    for package in &mut workspace.packages {
        for target in &mut package.targets {
            crate::rust_source::populate_target_modules(target)?;
        }
    }
    Ok(workspace)
}

fn find_workspace_root(
    requested_root: &Path,
    requested_document: &Value,
) -> Result<(PathBuf, Value), CargoDiscoveryError> {
    let requested_manifest = requested_root.join("Cargo.toml");
    if requested_document.get("workspace").is_some() {
        return Ok((requested_root.to_owned(), requested_document.clone()));
    }

    if let Some(workspace_path) = requested_document
        .get("package")
        .and_then(Value::as_table)
        .and_then(|package| package.get("workspace"))
        .and_then(Value::as_str)
    {
        let root = requested_root
            .join(workspace_path)
            .canonicalize()
            .map_err(|error| {
                invalid_manifest(
                    &requested_manifest,
                    format!("package.workspace points to an inaccessible directory: {error}"),
                )
            })?;
        let manifest = root.join("Cargo.toml");
        let document = read_manifest(&manifest)?;
        if document.get("workspace").is_none() {
            return Err(invalid_manifest(
                &manifest,
                "package.workspace does not point to a manifest with a [workspace] table",
            ));
        }
        return Ok((root, document));
    }

    let mut parent = requested_root.parent();
    while let Some(directory) = parent {
        let manifest = directory.join("Cargo.toml");
        if manifest.is_file() {
            let document = read_manifest(&manifest)?;
            if document.get("workspace").is_some() {
                return Ok((directory.to_owned(), document));
            }
        }
        parent = directory.parent();
    }

    Ok((requested_root.to_owned(), requested_document.clone()))
}

fn member_directories(
    workspace_root: &Path,
    workspace_document: &Value,
    requested_root: &Path,
    requested_document: &Value,
) -> Result<(Vec<PathBuf>, BTreeSet<PathBuf>), CargoDiscoveryError> {
    let workspace_manifest = workspace_root.join("Cargo.toml");
    let Some(workspace) = table(workspace_document, "workspace", &workspace_manifest)? else {
        return Ok((vec![requested_root.to_owned()], BTreeSet::new()));
    };

    let members = string_array(
        workspace.get("members"),
        "workspace.members",
        &workspace_manifest,
    )?;
    let excludes = string_array(
        workspace.get("exclude"),
        "workspace.exclude",
        &workspace_manifest,
    )?;
    let mut directories = BTreeSet::new();
    for pattern in members {
        directories.extend(expand_directories(workspace_root, &pattern)?);
    }
    if requested_document.get("package").is_some() {
        directories.insert(requested_root.to_owned());
    }
    if workspace_document.get("package").is_some() {
        directories.insert(workspace_root.to_owned());
    }

    let mut excluded = BTreeSet::new();
    for pattern in excludes {
        excluded.extend(expand_directories(workspace_root, &pattern)?);
    }
    directories.retain(|directory| !excluded.contains(directory));
    Ok((
        directories
            .into_iter()
            .filter(|directory| directory.join("Cargo.toml").is_file())
            .collect(),
        excluded,
    ))
}

fn expand_directories(root: &Path, pattern: &str) -> Result<Vec<PathBuf>, CargoDiscoveryError> {
    let absolute_pattern = root.join(pattern).to_string_lossy().into_owned();
    let paths =
        glob(&absolute_pattern).map_err(|error| CargoDiscoveryError::WorkspaceMemberPattern {
            pattern: pattern.to_owned(),
            reason: error.to_string(),
        })?;
    let mut directories = BTreeSet::new();
    for entry in paths {
        let path = entry.map_err(|error| CargoDiscoveryError::WorkspaceMemberPattern {
            pattern: pattern.to_owned(),
            reason: error.to_string(),
        })?;
        let directory = if path.file_name().is_some_and(|name| name == "Cargo.toml") {
            path.parent().unwrap_or(&path)
        } else {
            path.as_path()
        };
        if directory.is_dir() {
            let canonical = directory.canonicalize().map_err(|error| {
                CargoDiscoveryError::WorkspaceMemberPattern {
                    pattern: pattern.to_owned(),
                    reason: error.to_string(),
                }
            })?;
            directories.insert(canonical);
        }
    }
    Ok(directories.into_iter().collect())
}

fn parse_package(
    manifest_path: &Path,
    document: &Value,
    workspace_package: Option<&toml::map::Map<String, Value>>,
    workspace_document: &Value,
    workspace_root: &Path,
) -> Result<Option<CargoPackage>, CargoDiscoveryError> {
    let Some(package) = table(document, "package", manifest_path)? else {
        return Ok(None);
    };
    let name = required_string(package.get("name"), "package.name", manifest_path)?;
    let version = inherited_string(
        package.get("version"),
        workspace_package,
        "version",
        manifest_path,
    )?
    .ok_or_else(|| invalid_manifest(manifest_path, "package.version is missing"))?;
    let description = inherited_string(
        package.get("description"),
        workspace_package,
        "description",
        manifest_path,
    )?;
    let package_root = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let targets = discover_targets(
        manifest_path,
        package_root,
        document,
        package,
        workspace_package,
        &name,
    )?;
    let features = discover_features(manifest_path, document, workspace_document, workspace_root)?;
    let dependencies = discover_dependencies(
        manifest_path,
        document,
        workspace_document,
        workspace_root,
        package_root,
    )?;
    let normalized_manifest = manifest_path
        .canonicalize()
        .unwrap_or_else(|_| manifest_path.to_owned());

    Ok(Some(CargoPackage {
        name,
        version,
        manifest_path: normalized_manifest,
        description,
        targets,
        features,
        dependencies,
    }))
}

fn inherited_string(
    value: Option<&Value>,
    workspace_package: Option<&toml::map::Map<String, Value>>,
    field: &str,
    manifest_path: &Path,
) -> Result<Option<String>, CargoDiscoveryError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if let Some(text) = value.as_str() {
        return Ok(Some(text.to_owned()));
    }
    if value
        .as_table()
        .and_then(|table| table.get("workspace"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return workspace_package
            .and_then(|workspace| workspace.get(field))
            .and_then(Value::as_str)
            .map(|text| Some(text.to_owned()))
            .ok_or_else(|| {
                invalid_manifest(
                    manifest_path,
                    format!("package.{field} inherits a missing workspace.package.{field}"),
                )
            });
    }
    Err(invalid_manifest(
        manifest_path,
        format!("package.{field} must be a string or inherit from the workspace"),
    ))
}

fn discover_dependencies(
    manifest_path: &Path,
    document: &Value,
    workspace_document: &Value,
    workspace_root: &Path,
    package_root: &Path,
) -> Result<Vec<CargoDependency>, CargoDiscoveryError> {
    let sections = dependency_sections(document, manifest_path)?;

    let workspace_manifest = workspace_root.join("Cargo.toml");
    let workspace_dependencies = table(workspace_document, "workspace", &workspace_manifest)?
        .and_then(|workspace| workspace.get("dependencies"))
        .and_then(Value::as_table);
    let mut dependencies = Vec::new();
    for (section, kind) in sections {
        for (alias, value) in section {
            let dependency_workspace = value
                .as_table()
                .and_then(|table| table.get("workspace"))
                .and_then(Value::as_bool)
                == Some(true);
            let (configuration, base_directory) = if dependency_workspace {
                let inherited = workspace_dependencies
                    .and_then(|workspace| workspace.get(alias))
                    .ok_or_else(|| {
                        invalid_manifest(
                            manifest_path,
                            format!("dependency `{alias}` inherits a missing workspace dependency"),
                        )
                    })?;
                (inherited.as_table(), workspace_root)
            } else {
                match value {
                    Value::Table(configuration) => (Some(configuration), package_root),
                    Value::String(_) => (None, package_root),
                    _ => {
                        return Err(invalid_manifest(
                            manifest_path,
                            format!("dependency `{alias}` must be a string or table"),
                        ));
                    }
                }
            };
            let name = configuration
                .map(|configuration| optional_string_field(configuration, "package", manifest_path))
                .transpose()?
                .flatten()
                .unwrap_or(alias)
                .to_owned();
            let path = configuration
                .map(|configuration| optional_string_field(configuration, "path", manifest_path))
                .transpose()?
                .flatten()
                .map(|path| resolve_path(base_directory, path));
            dependencies.push(CargoDependency { name, path, kind });
        }
    }
    dependencies.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| dependency_kind_order(left.kind).cmp(&dependency_kind_order(right.kind)))
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(dependencies)
}

fn dependency_sections<'a>(
    document: &'a Value,
    manifest_path: &Path,
) -> Result<Vec<(&'a toml::map::Map<String, Value>, CargoDependencyKind)>, CargoDiscoveryError> {
    let mut sections = Vec::new();
    for (key, kind) in [
        ("dependencies", CargoDependencyKind::Normal),
        ("build-dependencies", CargoDependencyKind::Build),
        ("dev-dependencies", CargoDependencyKind::Dev),
    ] {
        if let Some(section) = table(document, key, manifest_path)? {
            sections.push((section, kind));
        }
    }
    if let Some(targets) = table(document, "target", manifest_path)? {
        for target in targets.values() {
            let target = target.as_table().ok_or_else(|| {
                invalid_manifest(
                    manifest_path,
                    "target-specific dependencies must be a table",
                )
            })?;
            for (key, kind) in [
                ("dependencies", CargoDependencyKind::Normal),
                ("build-dependencies", CargoDependencyKind::Build),
                ("dev-dependencies", CargoDependencyKind::Dev),
            ] {
                if let Some(section) = target.get(key) {
                    let section = section.as_table().ok_or_else(|| {
                        invalid_manifest(
                            manifest_path,
                            format!("target-specific `{key}` must be a table"),
                        )
                    })?;
                    sections.push((section, kind));
                }
            }
        }
    }
    Ok(sections)
}

fn discover_features(
    manifest_path: &Path,
    document: &Value,
    workspace_document: &Value,
    workspace_root: &Path,
) -> Result<Vec<String>, CargoDiscoveryError> {
    let feature_table = table(document, "features", manifest_path)?;
    let mut names = BTreeSet::new();
    let mut dependency_features = BTreeSet::new();
    if let Some(features) = feature_table {
        for (name, members) in features {
            names.insert(name.clone());
            for member in string_array(Some(members), &format!("features.{name}"), manifest_path)? {
                if let Some(dependency) = member.strip_prefix("dep:") {
                    dependency_features.insert(dependency.to_owned());
                }
            }
        }
    }

    let workspace_manifest = workspace_root.join("Cargo.toml");
    let workspace_dependencies = table(workspace_document, "workspace", &workspace_manifest)?
        .and_then(|workspace| workspace.get("dependencies"))
        .and_then(Value::as_table);
    for (section, _) in dependency_sections(document, manifest_path)? {
        for (alias, value) in section {
            let package_configuration = value.as_table();
            let inherited_configuration = if package_configuration
                .and_then(|configuration| configuration.get("workspace"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                Some(
                    workspace_dependencies
                        .and_then(|dependencies| dependencies.get(alias))
                        .ok_or_else(|| {
                            invalid_manifest(
                                manifest_path,
                                format!(
                                    "dependency `{alias}` inherits a missing workspace dependency"
                                ),
                            )
                        })?,
                )
            } else {
                None
            };
            let optional =
                optional_boolean_field(package_configuration, "optional", manifest_path)?
                    .or(optional_boolean_field(
                        inherited_configuration.and_then(Value::as_table),
                        "optional",
                        &workspace_manifest,
                    )?)
                    .unwrap_or(false);
            if optional && !dependency_features.contains(alias) {
                names.insert(alias.clone());
            }
        }
    }
    Ok(names.into_iter().collect())
}

fn optional_boolean_field(
    table: Option<&toml::map::Map<String, Value>>,
    field: &str,
    manifest_path: &Path,
) -> Result<Option<bool>, CargoDiscoveryError> {
    match table.and_then(|table| table.get(field)) {
        Some(Value::Boolean(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid_manifest(
            manifest_path,
            format!("dependency.{field} must be a boolean"),
        )),
        None => Ok(None),
    }
}

fn dependency_kind_order(kind: CargoDependencyKind) -> u8 {
    match kind {
        CargoDependencyKind::Normal => 0,
        CargoDependencyKind::Build => 1,
        CargoDependencyKind::Dev => 2,
    }
}

fn discover_targets(
    manifest_path: &Path,
    package_root: &Path,
    document: &Value,
    package: &toml::map::Map<String, Value>,
    workspace_package: Option<&toml::map::Map<String, Value>>,
    package_name: &str,
) -> Result<Vec<CargoTarget>, CargoDiscoveryError> {
    let mut targets = Vec::new();

    let edition = inherited_string(
        package.get("edition"),
        workspace_package,
        "edition",
        manifest_path,
    )?
    .unwrap_or_else(|| "2015".to_owned());
    let auto_discovery_default = edition != "2015"
        || !["lib", "bin", "example", "test", "bench"]
            .iter()
            .any(|target| document.get(target).is_some());
    let autolib = boolean_option(package, "autolib", auto_discovery_default, manifest_path)?;
    if let Some(configuration) = document.get("lib") {
        add_explicit_target(
            &mut targets,
            manifest_path,
            package_root,
            configuration,
            "lib",
            package_name,
        )?;
    } else if autolib {
        add_default_target(
            &mut targets,
            package_root,
            "src/lib.rs",
            package_name.replace('-', "_"),
            "lib",
        );
    }

    let autobins = boolean_option(package, "autobins", auto_discovery_default, manifest_path)?;
    let autoexamples = boolean_option(
        package,
        "autoexamples",
        auto_discovery_default,
        manifest_path,
    )?;
    let autotests = boolean_option(package, "autotests", auto_discovery_default, manifest_path)?;
    let autobenches = boolean_option(
        package,
        "autobenches",
        auto_discovery_default,
        manifest_path,
    )?;
    for (field, kind, default_directory, automatic) in [
        ("bin", "bin", "src/bin", autobins),
        ("example", "example", "examples", autoexamples),
        ("test", "test", "tests", autotests),
        ("bench", "bench", "benches", autobenches),
    ] {
        if let Some(configurations) = document.get(field) {
            for configuration in target_configurations(configurations, field, manifest_path)? {
                add_explicit_target(
                    &mut targets,
                    manifest_path,
                    package_root,
                    configuration,
                    kind,
                    package_name,
                )?;
            }
        }
        if automatic {
            if field == "bin" {
                add_default_target(
                    &mut targets,
                    package_root,
                    "src/main.rs",
                    package_name.to_owned(),
                    kind,
                );
            }
            add_automatic_targets(&mut targets, package_root, default_directory, kind)?;
        }
    }

    match package.get("build") {
        Some(Value::Boolean(false)) => {}
        Some(Value::String(path)) => add_required_target(
            &mut targets,
            manifest_path,
            package_root.join(path),
            "build-script-build",
            vec!["custom-build".to_owned()],
            "build script",
        )?,
        Some(Value::Boolean(true)) | None => {
            if package_root.join("build.rs").is_file() {
                add_default_target(
                    &mut targets,
                    package_root,
                    "build.rs",
                    "build-script-build".to_owned(),
                    "custom-build",
                );
            }
        }
        Some(_) => {
            return Err(invalid_manifest(
                manifest_path,
                "package.build must be a boolean or a path string",
            ));
        }
    }

    targets.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.source_path.cmp(&right.source_path))
    });
    Ok(targets)
}

fn target_configurations<'a>(
    value: &'a Value,
    field: &str,
    manifest_path: &Path,
) -> Result<Vec<&'a Value>, CargoDiscoveryError> {
    match value {
        Value::Array(values) => Ok(values.iter().collect()),
        Value::Table(_) => Ok(vec![value]),
        _ => Err(invalid_manifest(
            manifest_path,
            format!("`{field}` must be a table or array of tables"),
        )),
    }
}

fn boolean_option(
    package: &toml::map::Map<String, Value>,
    field: &str,
    default: bool,
    manifest_path: &Path,
) -> Result<bool, CargoDiscoveryError> {
    match package.get(field) {
        Some(Value::Boolean(value)) => Ok(*value),
        Some(_) => Err(invalid_manifest(
            manifest_path,
            format!("package.{field} must be a boolean"),
        )),
        None => Ok(default),
    }
}

fn add_explicit_target(
    targets: &mut Vec<CargoTarget>,
    manifest_path: &Path,
    package_root: &Path,
    configuration: &Value,
    kind: &str,
    package_name: &str,
) -> Result<(), CargoDiscoveryError> {
    let configuration = configuration.as_table().ok_or_else(|| {
        invalid_manifest(manifest_path, format!("target `{kind}` must be a table"))
    })?;
    let configured_path = optional_string_field(configuration, "path", manifest_path)?;
    let configured_name = optional_string_field(configuration, "name", manifest_path)?;
    if kind != "lib" && configured_name.is_none() {
        return Err(invalid_manifest(
            manifest_path,
            format!("target `{kind}` requires a name"),
        ));
    }
    let (default_name, default_path) = match kind {
        "lib" => (package_name.replace('-', "_"), "src/lib.rs".to_owned()),
        "bin" => {
            let name = configured_name.unwrap_or(package_name);
            let path = if configured_name.is_none() || name == package_name {
                "src/main.rs".to_owned()
            } else {
                format!("src/bin/{name}.rs")
            };
            (name.to_owned(), path)
        }
        _ => {
            let name = configured_name.unwrap_or(kind);
            let directory = match kind {
                "example" => "examples",
                "test" => "tests",
                "bench" => "benches",
                _ => kind,
            };
            (name.to_owned(), format!("{directory}/{name}.rs"))
        }
    };
    let name = configured_name.unwrap_or(&default_name).to_owned();
    let source_path = package_root.join(configured_path.unwrap_or(&default_path));
    let target_kinds = if kind == "lib" {
        if configuration.get("proc-macro").and_then(Value::as_bool) == Some(true) {
            vec!["proc-macro".to_owned()]
        } else if let Some(crate_types) = configuration.get("crate-type") {
            string_array(Some(crate_types), "lib.crate-type", manifest_path)?
        } else {
            vec!["lib".to_owned()]
        }
    } else {
        vec![kind.to_owned()]
    };
    add_required_target(
        targets,
        manifest_path,
        source_path,
        name,
        target_kinds,
        "declared target",
    )
}

fn add_required_target(
    targets: &mut Vec<CargoTarget>,
    manifest_path: &Path,
    source_path: PathBuf,
    name: impl Into<String>,
    kind: Vec<String>,
    label: &str,
) -> Result<(), CargoDiscoveryError> {
    if !source_path.is_file() {
        return Err(invalid_manifest(
            manifest_path,
            format!("{label} source {} does not exist", source_path.display()),
        ));
    }
    add_target(targets, source_path, name.into(), kind);
    Ok(())
}

fn optional_string_field<'a>(
    table: &'a toml::map::Map<String, Value>,
    field: &str,
    manifest_path: &Path,
) -> Result<Option<&'a str>, CargoDiscoveryError> {
    match table.get(field) {
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(invalid_manifest(
            manifest_path,
            format!("target.{field} must be a string"),
        )),
        None => Ok(None),
    }
}

fn add_default_target(
    targets: &mut Vec<CargoTarget>,
    package_root: &Path,
    relative_path: &str,
    name: String,
    kind: &str,
) {
    let source_path = package_root.join(relative_path);
    if source_path.is_file() {
        add_target(targets, source_path, name, vec![kind.to_owned()]);
    }
}

fn add_automatic_targets(
    targets: &mut Vec<CargoTarget>,
    package_root: &Path,
    relative_directory: &str,
    kind: &str,
) -> Result<(), CargoDiscoveryError> {
    let directory = package_root.join(relative_directory);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(invalid_manifest(
                &package_root.join("Cargo.toml"),
                format!("could not inspect {}: {error}", directory.display()),
            ));
        }
    };
    let mut entries = entries
        .map(|entry| {
            entry.map(|entry| entry.path()).map_err(|error| {
                invalid_manifest(
                    &package_root.join("Cargo.toml"),
                    format!("could not inspect {}: {error}", directory.display()),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort();
    for entry in entries {
        if entry.is_file() && entry.extension().is_some_and(|extension| extension == "rs") {
            let name = entry
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_owned();
            add_target(targets, entry, name, vec![kind.to_owned()]);
        } else if entry.is_dir() {
            let main = entry.join("main.rs");
            if main.is_file() {
                let name = entry
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned();
                add_target(targets, main, name, vec![kind.to_owned()]);
            }
        }
    }
    Ok(())
}

fn add_target(
    targets: &mut Vec<CargoTarget>,
    source_path: PathBuf,
    name: String,
    kind: Vec<String>,
) {
    if targets
        .iter()
        .any(|target| target.name == name && target.kind == kind)
    {
        return;
    }
    targets.push(CargoTarget {
        name,
        kind,
        source_path: source_path.canonicalize().unwrap_or(source_path),
        modules: Vec::new(),
    });
}

fn table<'a>(
    document: &'a Value,
    key: &str,
    manifest_path: &Path,
) -> Result<Option<&'a toml::map::Map<String, Value>>, CargoDiscoveryError> {
    match document.get(key) {
        Some(Value::Table(table)) => Ok(Some(table)),
        Some(_) => Err(invalid_manifest(
            manifest_path,
            format!("`{key}` must be a table"),
        )),
        None => Ok(None),
    }
}

fn string_array(
    value: Option<&Value>,
    label: &str,
    manifest_path: &Path,
) -> Result<Vec<String>, CargoDiscoveryError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err(invalid_manifest(
            manifest_path,
            format!("`{label}` must be an array"),
        ));
    };
    values
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                invalid_manifest(manifest_path, format!("`{label}` entries must be strings"))
            })
        })
        .collect()
}

fn required_string(
    value: Option<&Value>,
    label: &str,
    manifest_path: &Path,
) -> Result<String, CargoDiscoveryError> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid_manifest(manifest_path, format!("`{label}` must be a string")))
}

fn resolve_path(root: &Path, path: &str) -> PathBuf {
    let path = root.join(path);
    path.canonicalize().unwrap_or(path)
}

fn read_manifest(manifest_path: &Path) -> Result<Value, CargoDiscoveryError> {
    let source = fs::read_to_string(manifest_path).map_err(|error| {
        invalid_manifest(manifest_path, format!("could not read manifest: {error}"))
    })?;
    toml::from_str(&source).map_err(|source| CargoDiscoveryError::InvalidManifestToml {
        path: manifest_path.to_owned(),
        source,
    })
}

fn invalid_manifest(path: &Path, reason: impl Into<String>) -> CargoDiscoveryError {
    CargoDiscoveryError::InvalidManifest {
        path: path.to_owned(),
        reason: reason.into(),
    }
}
