use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum ConfigInfraLanguage {
    Dockerfile,
    Terraform,
    Yaml,
}

impl ConfigInfraLanguage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Dockerfile => "dockerfile",
            Self::Terraform => "terraform",
            Self::Yaml => "yaml",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum ConfigInfraEntityKind {
    Resource,
    Service,
    Deployment,
    Job,
    Stage,
    TerraformModule,
    TerraformVariable,
    TerraformOutput,
    TerraformProvider,
}

impl ConfigInfraEntityKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Resource => "resource",
            Self::Service => "service",
            Self::Deployment => "deployment",
            Self::Job => "job",
            Self::Stage => "stage",
            Self::TerraformModule => "terraform-module",
            Self::TerraformVariable => "terraform-variable",
            Self::TerraformOutput => "terraform-output",
            Self::TerraformProvider => "terraform-provider",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ConfigInfraReference {
    Entity(String),
    File(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigInfraEntity {
    pub name: String,
    pub kind: ConfigInfraEntityKind,
    pub attributes: Vec<String>,
    pub references: Vec<ConfigInfraReference>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigInfraFile {
    pub path: PathBuf,
    pub language: ConfigInfraLanguage,
    pub entities: Vec<ConfigInfraEntity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigInfraWorkspace {
    pub files: Vec<ConfigInfraFile>,
}

pub(crate) fn discover_config_infra(
    root: &Path,
) -> Result<ConfigInfraWorkspace, CargoDiscoveryError> {
    let canonical_root = opened_root(root)?;
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    walk_files(root, &canonical_root, &mut seen, &mut paths)?;
    paths.sort();
    let files = paths
        .into_iter()
        .filter_map(|path| {
            let language = language_for(&path);
            let source = fs::read(&path)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            let relative = relative_path(root, &path);
            let entities = parse_entities(&source, language, &relative);
            if language == ConfigInfraLanguage::Yaml && entities.is_empty() {
                return None;
            }
            Some(ConfigInfraFile {
                path,
                language,
                entities,
            })
        })
        .collect();
    Ok(ConfigInfraWorkspace { files })
}

fn parse_entities(
    source: &str,
    language: ConfigInfraLanguage,
    relative: &str,
) -> Vec<ConfigInfraEntity> {
    match language {
        ConfigInfraLanguage::Yaml => parse_yaml(source, relative),
        ConfigInfraLanguage::Terraform => parse_terraform(source, relative),
        ConfigInfraLanguage::Dockerfile => parse_dockerfile(source),
    }
}

fn parse_yaml(source: &str, relative: &str) -> Vec<ConfigInfraEntity> {
    let Ok(documents) = YamlLoader::load_from_str(source) else {
        return Vec::new();
    };
    let mut entities = Vec::new();
    for document in documents {
        let services = &document["services"];
        if let Some(entries) = services.as_hash() {
            for (name, service) in entries {
                let Some(name) = name.as_str() else { continue };
                let mut references = yaml_string_values(&service["depends_on"])
                    .into_iter()
                    .map(ConfigInfraReference::Entity)
                    .collect::<Vec<_>>();
                references.extend(
                    compose_resource_names(&service["volumes"])
                        .into_iter()
                        .map(|name| ConfigInfraReference::Entity(format!("volumes/{name}"))),
                );
                references.extend(
                    compose_resource_names(&service["networks"])
                        .into_iter()
                        .map(|name| ConfigInfraReference::Entity(format!("networks/{name}"))),
                );
                let build = &service["build"];
                if !matches!(build, Yaml::BadValue | Yaml::Boolean(false) | Yaml::Null) {
                    let context = yaml_string(&build["context"])
                        .or_else(|| build.as_str().map(str::to_owned))
                        .unwrap_or_else(|| ".".to_owned());
                    let dockerfile = yaml_string(&build["dockerfile"])
                        .unwrap_or_else(|| "Dockerfile".to_owned());
                    references.push(ConfigInfraReference::File(normalize_relative(
                        Path::new(relative)
                            .parent()
                            .unwrap_or_else(|| Path::new(""))
                            .join(context)
                            .join(dockerfile),
                    )));
                }
                entities.push(entity(
                    name,
                    ConfigInfraEntityKind::Service,
                    &["service", "compose-service"],
                    references,
                ));
            }
        }
        for key in ["volumes", "networks"] {
            if let Some(resources) = document[key].as_hash() {
                for name in resources.keys().filter_map(Yaml::as_str) {
                    entities.push(entity(
                        &format!("{key}/{name}"),
                        ConfigInfraEntityKind::Resource,
                        &[
                            "resource",
                            if key == "volumes" {
                                "compose-volumes"
                            } else {
                                "compose-networks"
                            },
                        ],
                        Vec::new(),
                    ));
                }
            }
        }
        if let (Some(kind), Some(name)) = (
            yaml_string(&document["kind"]),
            yaml_string(&document["metadata"]["name"]),
        ) {
            let normalized = kind.to_ascii_lowercase();
            let is_deployment = matches!(
                normalized.as_str(),
                "deployment" | "statefulset" | "daemonset" | "job" | "cronjob"
            );
            entities.push(entity(
                &format!("{normalized}/{name}"),
                if is_deployment {
                    ConfigInfraEntityKind::Deployment
                } else {
                    ConfigInfraEntityKind::Resource
                },
                &["kubernetes", &normalized],
                Vec::new(),
            ));
        }
        if let Some(jobs) = document["jobs"].as_hash() {
            for (name, job) in jobs {
                let Some(name) = name.as_str() else { continue };
                let references = yaml_string_values(&job["needs"])
                    .into_iter()
                    .map(ConfigInfraReference::Entity)
                    .collect();
                entities.push(entity(
                    name,
                    ConfigInfraEntityKind::Job,
                    &["workflow-job"],
                    references,
                ));
            }
        }
    }
    unique_entities(entities)
}

fn parse_terraform(source: &str, relative: &str) -> Vec<ConfigInfraEntity> {
    let mut entities = Vec::new();
    let mut active_index: Option<usize> = None;
    let mut depth = 0i32;
    let mut capture_dependencies = false;
    for raw_line in source.lines() {
        let line = strip_hcl_comment(raw_line);
        let trimmed = line.trim();
        if active_index.is_none() {
            if let Some((block_kind, arguments)) = terraform_header(trimmed) {
                if let Some(entity) = terraform_entity(&block_kind, &arguments) {
                    entities.push(entity);
                    active_index = Some(entities.len() - 1);
                    capture_dependencies = false;
                }
            }
        }
        if let Some(index) = active_index {
            if line.contains("depends_on") && line.contains('=') {
                capture_dependencies = true;
            }
            if capture_dependencies {
                let references = hcl_references(&line);
                if let Some(active) = entities.get_mut(index) {
                    active
                        .references
                        .extend(references.into_iter().map(ConfigInfraReference::Entity));
                }
                if line.contains(']') {
                    capture_dependencies = false;
                }
            }
            if entities
                .get(index)
                .is_some_and(|entity| entity.kind == ConfigInfraEntityKind::TerraformModule)
            {
                if let Some(source_path) = quoted_assignment(&line, "source") {
                    if source_path.starts_with("./") || source_path.starts_with("../") {
                        let module_file = normalize_relative(
                            Path::new(relative)
                                .parent()
                                .unwrap_or_else(|| Path::new(""))
                                .join(source_path)
                                .join("main.tf"),
                        );
                        if let Some(active) = entities.get_mut(index) {
                            active
                                .references
                                .push(ConfigInfraReference::File(module_file));
                        }
                    }
                }
            }
            depth += brace_delta(&line);
            if depth <= 0 {
                active_index = None;
            }
        }
    }
    unique_entities(entities)
}

fn terraform_header(line: &str) -> Option<(String, Vec<String>)> {
    let kind = [
        "resource", "data", "module", "variable", "output", "provider",
    ]
    .into_iter()
    .find(|kind| {
        line.strip_prefix(kind)
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
    })?;
    Some((kind.to_owned(), quoted_values(line)))
}

fn terraform_entity(kind: &str, arguments: &[String]) -> Option<ConfigInfraEntity> {
    let first = arguments.first()?;
    if kind == "resource" || kind == "data" {
        let name = arguments.get(1)?;
        let prefix = if kind == "data" { "data." } else { "" };
        return Some(entity(
            &format!("{prefix}{first}.{name}"),
            ConfigInfraEntityKind::Resource,
            &[
                "terraform",
                if kind == "data" {
                    "terraform-data"
                } else {
                    "terraform-resource"
                },
            ],
            Vec::new(),
        ));
    }
    let entity_kind = match kind {
        "module" => ConfigInfraEntityKind::TerraformModule,
        "variable" => ConfigInfraEntityKind::TerraformVariable,
        "output" => ConfigInfraEntityKind::TerraformOutput,
        "provider" => ConfigInfraEntityKind::TerraformProvider,
        _ => return None,
    };
    Some(entity(first, entity_kind, &["terraform", kind], Vec::new()))
}

fn parse_dockerfile(source: &str) -> Vec<ConfigInfraEntity> {
    let mut entities = Vec::new();
    let mut aliases = HashSet::new();
    let mut stage_number = 0usize;
    let mut active_stage_index: Option<usize> = None;
    for line in source.lines() {
        let words = line.split_whitespace().collect::<Vec<_>>();
        if words
            .first()
            .is_some_and(|word| word.eq_ignore_ascii_case("FROM"))
        {
            let Some(image) = words.get(1) else { continue };
            stage_number += 1;
            let alias = words
                .windows(2)
                .find(|pair| pair[0].eq_ignore_ascii_case("AS"))
                .and_then(|pair| pair.get(1))
                .copied();
            let name = alias
                .map(str::to_owned)
                .unwrap_or_else(|| format!("stage-{stage_number}"));
            let references = if aliases.contains(*image) {
                vec![ConfigInfraReference::Entity((*image).to_owned())]
            } else {
                Vec::new()
            };
            entities.push(entity(
                &name,
                ConfigInfraEntityKind::Stage,
                &["docker-stage", "from"],
                references,
            ));
            active_stage_index = Some(entities.len() - 1);
            if let Some(alias) = alias {
                aliases.insert(alias.to_owned());
            }
        } else if let Some(target) = words.iter().find_map(|word| word.strip_prefix("--from=")) {
            if aliases.contains(target) {
                if let Some(index) = active_stage_index {
                    if let Some(stage) = entities.get_mut(index) {
                        stage
                            .references
                            .push(ConfigInfraReference::Entity(target.to_owned()));
                    }
                }
            }
        }
    }
    if entities.is_empty() {
        entities.push(entity(
            "default",
            ConfigInfraEntityKind::Stage,
            &["docker-stage"],
            Vec::new(),
        ));
    }
    unique_entities(entities)
}

fn entity(
    name: &str,
    kind: ConfigInfraEntityKind,
    attributes: &[&str],
    references: Vec<ConfigInfraReference>,
) -> ConfigInfraEntity {
    ConfigInfraEntity {
        name: name.to_owned(),
        kind,
        attributes: attributes.iter().map(|value| (*value).to_owned()).collect(),
        references,
    }
}

fn walk_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let Some(canonical) = confined_config_path(directory, root) else {
        return Ok(());
    };
    if !seen.insert(canonical) {
        return Ok(());
    }
    let entries =
        fs::read_dir(directory).map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
        let path = entry.path();
        let file_type =
            entry
                .file_type()
                .map_err(|source| CargoDiscoveryError::RepositoryPath {
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_dir() {
            if !skipped_directory(&entry.file_name().to_string_lossy()) {
                walk_files(&path, root, seen, files)?;
            }
        } else if file_type.is_file()
            && is_config_file(&path)
            && confined_config_path(&path, root).is_some()
        {
            files.push(path);
        }
    }
    Ok(())
}

fn confined_config_path(path: &Path, root: &Path) -> Option<PathBuf> {
    match confined_canonical(path, root) {
        Ok(canonical) => Some(canonical),
        Err(CargoDiscoveryError::PathOutsideOpenedFolder { .. }) => None,
        Err(CargoDiscoveryError::RepositoryPath { source, .. })
            if source.kind() == io::ErrorKind::NotFound =>
        {
            None
        }
        Err(_) => None,
    }
}

fn skipped_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | ".terraform"
            | "node_modules"
            | "target"
            | "build"
            | "dist"
            | "out"
            | "vendor"
            | "testdata"
            | "fixtures"
    )
}

fn is_config_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name == "dockerfile" || name.starts_with("dockerfile.") {
        return true;
    }
    matches!(
        extension(path).as_deref(),
        Some("yaml" | "yml" | "tf" | "tfvars" | "hcl")
    )
}

fn language_for(path: &Path) -> ConfigInfraLanguage {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name == "dockerfile" || name.starts_with("dockerfile.") {
        return ConfigInfraLanguage::Dockerfile;
    }
    if matches!(extension(path).as_deref(), Some("tf" | "tfvars" | "hcl")) {
        ConfigInfraLanguage::Terraform
    } else {
        ConfigInfraLanguage::Yaml
    }
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
}

fn yaml_string(yaml: &Yaml) -> Option<String> {
    yaml.as_str().map(str::to_owned)
}

fn yaml_string_values(yaml: &Yaml) -> Vec<String> {
    if let Some(value) = yaml.as_str() {
        return vec![value.to_owned()];
    }
    if let Some(values) = yaml.as_vec() {
        return values
            .iter()
            .filter_map(Yaml::as_str)
            .map(str::to_owned)
            .collect();
    }
    if let Some(values) = yaml.as_hash() {
        return values
            .keys()
            .filter_map(Yaml::as_str)
            .map(str::to_owned)
            .collect();
    }
    Vec::new()
}

fn compose_resource_names(yaml: &Yaml) -> Vec<String> {
    if let Some(value) = yaml.as_str() {
        return vec![value.split(':').next().unwrap_or(value).to_owned()];
    }
    if let Some(values) = yaml.as_vec() {
        return values
            .iter()
            .filter_map(|value| {
                value
                    .as_str()
                    .map(|name| name.split(':').next().unwrap_or(name).to_owned())
                    .or_else(|| yaml_string(&value["source"]))
            })
            .collect();
    }
    if let Some(values) = yaml.as_hash() {
        return values
            .keys()
            .filter_map(Yaml::as_str)
            .map(str::to_owned)
            .collect();
    }
    Vec::new()
}

fn quoted_values(source: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut chars = source.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '"' {
            continue;
        }
        let mut value = String::new();
        let mut escaped = false;
        for next in chars.by_ref() {
            if escaped {
                value.push(next);
                escaped = false;
            } else if next == '\\' {
                escaped = true;
            } else if next == '"' {
                break;
            } else {
                value.push(next);
            }
        }
        values.push(value);
    }
    values
}

fn quoted_assignment(line: &str, name: &str) -> Option<String> {
    let (key, value) = line.trim().split_once('=')?;
    (key.trim() == name)
        .then(|| quoted_values(value).into_iter().next())
        .flatten()
}

fn strip_hcl_comment(line: &str) -> String {
    let mut quoted = false;
    let mut escaped = false;
    let chars = line.char_indices().collect::<Vec<_>>();
    for (index, character) in chars.iter().copied() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quoted {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            continue;
        }
        if !quoted && (character == '#' || (character == '/' && line[index..].starts_with("//"))) {
            return line[..index].to_owned();
        }
    }
    line.to_owned()
}

fn brace_delta(line: &str) -> i32 {
    let mut quoted = false;
    let mut escaped = false;
    let mut delta = 0;
    for character in strip_hcl_comment(line).chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quoted {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        if character == '{' {
            delta += 1;
        }
        if character == '}' {
            delta -= 1;
        }
    }
    delta
}

fn hcl_references(line: &str) -> Vec<String> {
    let mut references = Vec::new();
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric()
                || bytes[index] == b'_'
                || bytes[index] == b'-')
        {
            index += 1;
        }
        if index == start || bytes.get(index) != Some(&b'.') {
            index = start + 1;
            continue;
        }
        index += 1;
        let second = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric()
                || bytes[index] == b'_'
                || bytes[index] == b'-')
        {
            index += 1;
        }
        if second < index {
            references.push(format!(
                "{}.{}",
                &line[start..index].split('.').next().unwrap_or(""),
                &line[second..index]
            ));
        }
    }
    references
}

fn normalize_relative(path: PathBuf) -> String {
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
    path_to_slashes(&normalized)
}

fn relative_path(root: &Path, path: &Path) -> String {
    path_to_slashes(path.strip_prefix(root).unwrap_or(path))
}

fn path_to_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn unique_entities(entities: Vec<ConfigInfraEntity>) -> Vec<ConfigInfraEntity> {
    let mut unique = HashMap::<(ConfigInfraEntityKind, String), ConfigInfraEntity>::new();
    for entity in entities {
        let key = (entity.kind, entity.name.clone());
        unique
            .entry(key)
            .and_modify(|existing| existing.references.extend(entity.references.clone()))
            .or_insert(entity);
    }
    let mut entities = unique.into_values().collect::<Vec<_>>();
    entities.sort_by(|left, right| {
        left.kind
            .as_str()
            .cmp(right.kind.as_str())
            .then(left.name.cmp(&right.name))
    });
    for entity in &mut entities {
        entity
            .references
            .sort_by(|left, right| reference_key(left).cmp(&reference_key(right)));
        entity.references.dedup();
    }
    entities
}

fn reference_key(reference: &ConfigInfraReference) -> String {
    match reference {
        ConfigInfraReference::Entity(target) => format!("entity:{target}"),
        ConfigInfraReference::File(target) => format!("file:{target}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{discover_config_infra, ConfigInfraEntityKind};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "lightwell-config-infra-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("temp directory");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/config-infra-sample")
    }

    #[test]
    fn discovers_yaml_services_resources_and_workflow_wiring() {
        let workspace = discover_config_infra(&fixture_root()).expect("discover infra fixture");
        let compose = workspace
            .files
            .iter()
            .find(|file| file.path.ends_with("compose.yaml"))
            .expect("compose");
        let api = compose
            .entities
            .iter()
            .find(|entity| entity.name == "api" && entity.kind == ConfigInfraEntityKind::Service)
            .expect("api service");
        assert!(api
            .references
            .contains(&super::ConfigInfraReference::Entity("db".to_owned())));
        assert!(api
            .references
            .contains(&super::ConfigInfraReference::File("Dockerfile".to_owned())));
        assert!(compose
            .entities
            .iter()
            .any(|entity| entity.name == "volumes/data"
                && entity.kind == ConfigInfraEntityKind::Resource));
        let workflow = workspace
            .files
            .iter()
            .find(|file| file.path.ends_with("deploy.yml"))
            .expect("workflow");
        assert!(workflow
            .entities
            .iter()
            .any(|entity| entity.name == "deploy"
                && entity
                    .references
                    .contains(&super::ConfigInfraReference::Entity("test".to_owned()))));
        let kubernetes = workspace
            .files
            .iter()
            .find(|file| file.path.ends_with("k8s.yml"))
            .expect("kubernetes");
        assert!(kubernetes
            .entities
            .iter()
            .any(|entity| entity.name == "deployment/api"
                && entity.kind == ConfigInfraEntityKind::Deployment));
        assert!(kubernetes
            .entities
            .iter()
            .any(|entity| entity.name == "service/api"
                && entity.kind == ConfigInfraEntityKind::Resource));
    }

    #[test]
    fn discovers_terraform_resources_and_docker_stages() {
        let workspace = discover_config_infra(&fixture_root()).expect("discover infra fixture");
        let terraform = workspace
            .files
            .iter()
            .find(|file| file.path.ends_with("main.tf"))
            .expect("terraform");
        assert!(terraform
            .entities
            .iter()
            .any(|entity| entity.name == "aws_vpc.main"
                && entity.kind == ConfigInfraEntityKind::Resource));
        let app = terraform
            .entities
            .iter()
            .find(|entity| entity.name == "aws_instance.app")
            .expect("app resource");
        assert!(app
            .references
            .contains(&super::ConfigInfraReference::Entity(
                "aws_vpc.main".to_owned()
            )));
        let dockerfile = workspace
            .files
            .iter()
            .find(|file| file.path.ends_with("Dockerfile"))
            .expect("Dockerfile");
        assert!(dockerfile
            .entities
            .iter()
            .any(|entity| entity.name == "runtime"
                && entity.kind == ConfigInfraEntityKind::Stage
                && entity
                    .references
                    .contains(&super::ConfigInfraReference::Entity("builder".to_owned()))));
    }

    #[test]
    fn ignores_generated_directories_and_finds_dockerfile_variants() {
        let root = TempDir::new();
        fs::create_dir_all(root.0.join(".github/workflows")).expect("workflow dir");
        fs::create_dir_all(root.0.join(".terraform")).expect("generated dir");
        fs::create_dir_all(root.0.join("fixtures")).expect("fixtures dir");
        fs::write(
            root.0.join(".github/workflows/deploy.yml"),
            "jobs:\n  build:\n    runs-on: ubuntu-latest\n",
        )
        .expect("workflow");
        fs::write(
            root.0.join(".terraform/hidden.tf"),
            "resource \"x\" \"y\" {}\n",
        )
        .expect("hidden");
        fs::write(root.0.join("fixtures/hidden.yaml"), "services: {}\n").expect("fixture");
        fs::write(root.0.join("Dockerfile.dev"), "FROM alpine\n").expect("dockerfile");
        let workspace = discover_config_infra(&root.0).expect("discover");
        assert_eq!(workspace.files.len(), 2);
        assert!(workspace
            .files
            .iter()
            .any(|file| file.path.ends_with("Dockerfile.dev")));
        assert!(!workspace
            .files
            .iter()
            .any(|file| file.path.to_string_lossy().contains("/.terraform/")));
        assert!(!workspace
            .files
            .iter()
            .any(|file| file.path.to_string_lossy().contains("/fixtures/")));
    }

    #[test]
    fn omits_yaml_files_without_config_infra_entities() {
        let root = TempDir::new();
        fs::create_dir_all(root.0.join(".github/ISSUE_TEMPLATE")).expect("issue templates");
        fs::create_dir_all(root.0.join(".github/workflows")).expect("workflows");
        fs::write(
            root.0.join(".github/ISSUE_TEMPLATE/bug_report.yml"),
            "name: Bug report\ndescription: Report a bug\nbody: []\n",
        )
        .expect("issue template");
        fs::write(
            root.0.join(".github/dependabot.yml"),
            "version: 2\nupdates: []\n",
        )
        .expect("dependabot config");
        fs::write(
            root.0.join(".github/workflows/deploy.yml"),
            "jobs:\n  deploy:\n    runs-on: ubuntu-latest\n",
        )
        .expect("workflow");

        let workspace = discover_config_infra(&root.0).expect("discover");

        assert_eq!(workspace.files.len(), 1);
        assert!(workspace.files[0].path.ends_with("deploy.yml"));
    }

    #[test]
    fn config_infra_facts_join_the_workspace_map_without_cargo() {
        let map =
            crate::extract::extract_cargo_map(&fixture_root(), Some("Infra")).expect("extract map");
        assert!(map.blocks.iter().any(|block| matches!(block, crate::facts::FactBlock::Module(module)
            if module.language == "terraform" && module.module_path == "main.tf#resource:aws_instance.app")));
        let api = "module:config-infra:compose_2e_yaml:service:api";
        let db = "module:config-infra:compose_2e_yaml:service:db";
        assert!(map.connections.iter().any(|connection| matches!(connection, crate::facts::Connection::DependsOn { source, target, .. }
            if source == api && target == db)));
    }
}
