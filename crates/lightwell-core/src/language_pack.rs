//! Versioned language-pack manifests and filesystem discovery.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const LANGUAGE_PACK_SCHEMA_VERSION: u32 = 1;
pub const RUST_WORKSPACE_PACK_ID: &str = "rust";
const HIGHLIGHTER_HOOKS: &[&str] = &[
    "config-infra",
    "cpp",
    "dotnet",
    "go",
    "jvm",
    "php",
    "python",
    "ruby",
    "rust",
    "swift",
    "web",
];
const SOURCE_EXTRACTOR_HOOKS: &[&str] = &[
    "config-infra-module",
    "cpp-module",
    "dotnet-module",
    "go-module",
    "jvm-module",
    "php-module",
    "python-module",
    "ruby-module",
    "rust-workspace",
    "swift-module",
    "web-module",
];
const WORKSPACE_EXTRACTOR_HOOKS: &[&str] = &["rust"];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePackMonacoManifest {
    pub id: String,
    pub highlighter: Option<String>,
    pub by_extension: BTreeMap<String, String>,
    pub by_basename: BTreeMap<String, String>,
    pub by_basename_prefix: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePackExtractorManifest {
    pub source: Option<String>,
    pub workspace: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguagePackManifest {
    pub schema_version: u32,
    pub id: String,
    pub pack_version: String,
    pub extensions: Vec<String>,
    pub basenames: Vec<String>,
    pub basename_prefixes: Vec<String>,
    pub monaco: LanguagePackMonacoManifest,
    pub extractors: LanguagePackExtractorManifest,
    pub fixtures: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePackOrigin {
    Builtin,
    User,
    Workspace,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LanguagePackErrorCode {
    Read,
    Parse,
    Validation,
    Conflict,
    UnknownHook,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LanguagePackCatalogEntry {
    Loaded {
        id: String,
        pack_version: String,
        origin: LanguagePackOrigin,
        manifest_path: Option<String>,
        manifest: LanguagePackManifest,
    },
    Error {
        error_id: String,
        origin: LanguagePackOrigin,
        manifest_path: String,
        code: LanguagePackErrorCode,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackCatalog {
    pub revision: u64,
    pub user_packs_directory: String,
    pub entries: Vec<LanguagePackCatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadedLanguagePacks {
    pub manifests: Vec<LanguagePackManifest>,
    pub catalog: LanguagePackCatalog,
}

#[derive(Debug)]
pub enum LanguagePackLoaderError {
    BuiltinManifest(String),
    BuiltinConflict(String),
}

impl fmt::Display for LanguagePackLoaderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BuiltinManifest(message) | Self::BuiltinConflict(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl Error for LanguagePackLoaderError {}

#[derive(Debug)]
enum CandidateError {
    Read(String),
    Parse(String),
    Validation(String),
    Conflict(String),
    UnknownHook(String),
}

impl CandidateError {
    fn code(&self) -> LanguagePackErrorCode {
        match self {
            Self::Read(_) => LanguagePackErrorCode::Read,
            Self::Parse(_) => LanguagePackErrorCode::Parse,
            Self::Validation(_) => LanguagePackErrorCode::Validation,
            Self::Conflict(_) => LanguagePackErrorCode::Conflict,
            Self::UnknownHook(_) => LanguagePackErrorCode::UnknownHook,
        }
    }
}

impl fmt::Display for CandidateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(message)
            | Self::Parse(message)
            | Self::Validation(message)
            | Self::Conflict(message)
            | Self::UnknownHook(message) => formatter.write_str(message),
        }
    }
}

#[derive(Clone, Debug)]
struct ManifestCandidate {
    origin: LanguagePackOrigin,
    path: PathBuf,
}

pub fn builtin_language_pack_manifests(
) -> Result<Vec<LanguagePackManifest>, LanguagePackLoaderError> {
    let source = include_str!("../../../src/languages/manifests/builtin.language-packs.json");
    let manifests: Vec<LanguagePackManifest> = serde_json::from_str(source).map_err(|error| {
        LanguagePackLoaderError::BuiltinManifest(format!(
            "Could not parse the built-in language pack catalog: {error}"
        ))
    })?;
    for manifest in &manifests {
        validate_manifest(manifest).map_err(LanguagePackLoaderError::BuiltinManifest)?;
    }
    validate_conflicts(&manifests).map_err(LanguagePackLoaderError::BuiltinConflict)?;
    Ok(manifests)
}

pub fn default_user_language_packs_directory() -> Option<PathBuf> {
    if let Some(configured) = env::var_os("LIGHTWELL_LANGUAGE_PACKS_DIR") {
        return Some(PathBuf::from(configured));
    }
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(|home| {
            PathBuf::from(home)
                .join(".lightwell")
                .join("language-packs")
        })
}

pub fn read_language_pack_manifest(path: &Path) -> Result<LanguagePackManifest, String> {
    let source = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read language pack manifest {}: {error}",
            display_path(path)
        )
    })?;
    let manifest = serde_json::from_str(&source).map_err(|error| {
        format!(
            "Could not parse language pack manifest {}: {error}",
            display_path(path)
        )
    })?;
    validate_language_pack_manifest(&manifest)?;
    Ok(manifest)
}

pub fn validate_language_pack_manifest(manifest: &LanguagePackManifest) -> Result<(), String> {
    validate_manifest(manifest)
}

pub fn validate_language_pack_conflicts(manifests: &[LanguagePackManifest]) -> Result<(), String> {
    validate_conflicts(manifests)
}

pub fn load_language_packs(
    workspace_root: Option<&Path>,
    user_packs_directory: Option<&Path>,
    revision: u64,
) -> Result<LoadedLanguagePacks, LanguagePackLoaderError> {
    let builtins = builtin_language_pack_manifests()?;
    load_language_packs_with_builtins(&builtins, workspace_root, user_packs_directory, revision)
}

pub fn load_language_packs_with_builtins(
    builtins: &[LanguagePackManifest],
    workspace_root: Option<&Path>,
    user_packs_directory: Option<&Path>,
    revision: u64,
) -> Result<LoadedLanguagePacks, LanguagePackLoaderError> {
    for manifest in builtins {
        validate_manifest(manifest).map_err(LanguagePackLoaderError::BuiltinManifest)?;
    }
    validate_conflicts(builtins).map_err(LanguagePackLoaderError::BuiltinConflict)?;
    let user_directory = user_packs_directory
        .map(Path::to_path_buf)
        .or_else(default_user_language_packs_directory);
    let mut manifests = builtins.to_vec();
    let mut entries = builtins
        .iter()
        .map(|manifest| loaded_entry(manifest, LanguagePackOrigin::Builtin, None))
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    if let Some(directory) = &user_directory {
        candidates.extend(discover_candidates(directory, LanguagePackOrigin::User));
    }
    if let Some(root) = workspace_root {
        candidates.extend(discover_candidates(
            &root.join(".lightwell").join("language-packs"),
            LanguagePackOrigin::Workspace,
        ));
    }

    for candidate in candidates {
        match load_candidate(&candidate, &manifests) {
            Ok(manifest) => {
                entries.push(loaded_entry(
                    &manifest,
                    candidate.origin,
                    Some(&candidate.path),
                ));
                manifests.push(manifest);
            }
            Err(error) => entries.push(error_entry(&candidate, error)),
        }
    }

    Ok(LoadedLanguagePacks {
        manifests,
        catalog: LanguagePackCatalog {
            revision,
            user_packs_directory: user_directory
                .as_deref()
                .map(display_path)
                .unwrap_or_default(),
            entries,
        },
    })
}

fn discover_candidates(directory: &Path, origin: LanguagePackOrigin) -> Vec<ManifestCandidate> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(_) => {
            return vec![ManifestCandidate {
                origin,
                path: directory.to_path_buf(),
            }]
        }
    };
    let mut candidates = Vec::new();
    let mut sorted = entries.filter_map(Result::ok).collect::<Vec<_>>();
    sorted.sort_by_key(|entry| entry.file_name());
    for entry in sorted {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                candidates.push(ManifestCandidate { origin, path });
                continue;
            }
        };
        if file_type.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".language-pack.json"))
        {
            candidates.push(ManifestCandidate { origin, path });
        } else if file_type.is_dir() {
            let manifest_path = path.join("language-pack.json");
            if manifest_path.exists() {
                candidates.push(ManifestCandidate {
                    origin,
                    path: manifest_path,
                });
            }
        }
    }
    candidates
}

fn load_candidate(
    candidate: &ManifestCandidate,
    loaded: &[LanguagePackManifest],
) -> Result<LanguagePackManifest, CandidateError> {
    let source = fs::read_to_string(&candidate.path).map_err(|error| {
        CandidateError::Read(format!(
            "Could not read language pack manifest {}: {error}",
            display_path(&candidate.path)
        ))
    })?;
    let manifest: LanguagePackManifest = serde_json::from_str(&source).map_err(|error| {
        CandidateError::Parse(format!(
            "Could not parse language pack manifest {}: {error}",
            display_path(&candidate.path)
        ))
    })?;
    validate_manifest(&manifest).map_err(|message| {
        let message = format!(
            "Invalid language pack manifest at {}: {message}",
            display_path(&candidate.path)
        );
        if message.contains(" is not installed.") {
            CandidateError::UnknownHook(message)
        } else {
            CandidateError::Validation(message)
        }
    })?;
    let mut all = loaded.to_vec();
    all.push(manifest.clone());
    validate_conflicts(&all).map_err(CandidateError::Conflict)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &LanguagePackManifest) -> Result<(), String> {
    if manifest.schema_version != LANGUAGE_PACK_SCHEMA_VERSION {
        return Err(format!(
            "schemaVersion must be {LANGUAGE_PACK_SCHEMA_VERSION}; received {}.",
            manifest.schema_version
        ));
    }
    if !valid_id(&manifest.id) {
        return Err("id must begin with a lowercase letter and contain only lowercase letters, digits, and hyphens.".into());
    }
    if !valid_semver(&manifest.pack_version) {
        return Err("packVersion must be a semantic version such as 1.2.3.".into());
    }
    validate_unique(&manifest.extensions, "extensions", false)?;
    for (index, extension) in manifest.extensions.iter().enumerate() {
        if !valid_extension(extension) {
            return Err(format!(
                "extensions[{index}] must be a lowercase extension beginning with a dot."
            ));
        }
    }
    validate_unique(&manifest.basenames, "basenames", true)?;
    validate_unique(&manifest.basename_prefixes, "basenamePrefixes", true)?;
    for (field, values) in [
        ("basenames", &manifest.basenames),
        ("basenamePrefixes", &manifest.basename_prefixes),
    ] {
        for (index, value) in values.iter().enumerate() {
            if value.trim().is_empty() || value.contains('/') || value.contains('\\') {
                return Err(format!(
                    "{field}[{index}] must be non-empty and contain no path separators."
                ));
            }
        }
    }
    if manifest.extensions.is_empty()
        && manifest.basenames.is_empty()
        && manifest.basename_prefixes.is_empty()
    {
        return Err("at least one extension, basename, or basename prefix is required.".into());
    }
    if manifest.monaco.id.trim().is_empty() {
        return Err("monaco.id must be a non-empty string.".into());
    }
    validate_hook(
        &manifest.monaco.highlighter,
        "monaco.highlighter",
        HIGHLIGHTER_HOOKS,
    )?;
    validate_hook(
        &manifest.extractors.source,
        "extractors.source",
        SOURCE_EXTRACTOR_HOOKS,
    )?;
    validate_hook(
        &manifest.extractors.workspace,
        "extractors.workspace",
        WORKSPACE_EXTRACTOR_HOOKS,
    )?;
    if manifest
        .fixtures
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err("fixtures must be null or a non-empty string.".into());
    }
    for (extension, language_id) in &manifest.monaco.by_extension {
        if !valid_extension(extension) {
            return Err(format!(
                "monaco.byExtension key {extension:?} must be a lowercase extension beginning with a dot."
            ));
        }
        if language_id.trim().is_empty() {
            return Err(format!(
                "monaco.byExtension.{extension} must be a non-empty string."
            ));
        }
    }
    validate_monaco_map(
        &manifest.monaco.by_basename,
        &manifest.basenames,
        "monaco.byBasename",
        true,
    )?;
    validate_monaco_map(
        &manifest.monaco.by_basename_prefix,
        &manifest.basename_prefixes,
        "monaco.byBasenamePrefix",
        true,
    )?;
    Ok(())
}

fn validate_conflicts(manifests: &[LanguagePackManifest]) -> Result<(), String> {
    let mut ids = BTreeMap::new();
    let mut extensions = BTreeMap::new();
    let mut basenames = BTreeMap::new();
    let mut prefixes: Vec<(String, String)> = Vec::new();
    for manifest in manifests {
        insert_unique(&mut ids, &manifest.id, &manifest.id, "id")?;
        for extension in &manifest.extensions {
            insert_unique(
                &mut extensions,
                &extension.to_ascii_lowercase(),
                &manifest.id,
                "extension",
            )?;
        }
        for basename in &manifest.basenames {
            let lower = basename.to_ascii_lowercase();
            insert_unique(&mut basenames, &lower, &manifest.id, "basename")?;
            for (prefix, prefix_pack) in &prefixes {
                if lower.starts_with(prefix) && prefix_pack != &manifest.id {
                    return Err(conflict_message(
                        "basename",
                        basename,
                        prefix_pack,
                        &manifest.id,
                    ));
                }
            }
        }
        for prefix in &manifest.basename_prefixes {
            let lower = prefix.to_ascii_lowercase();
            for (existing, existing_pack) in &prefixes {
                if (lower.starts_with(existing) || existing.starts_with(&lower))
                    && existing_pack != &manifest.id
                {
                    return Err(conflict_message(
                        "basename prefix",
                        prefix,
                        existing_pack,
                        &manifest.id,
                    ));
                }
            }
            for (basename, basename_pack) in &basenames {
                if basename.starts_with(&lower) && basename_pack != &manifest.id {
                    return Err(conflict_message(
                        "basename",
                        basename,
                        basename_pack,
                        &manifest.id,
                    ));
                }
            }
            prefixes.push((lower, manifest.id.clone()));
        }
    }
    Ok(())
}

fn validate_unique(values: &[String], field: &str, case_insensitive: bool) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for value in values {
        let key = if case_insensitive {
            value.to_ascii_lowercase()
        } else {
            value.clone()
        };
        if !seen.insert(key) {
            return Err(format!("{field} contains duplicate values."));
        }
    }
    Ok(())
}

fn validate_hook(value: &Option<String>, field: &str, installed: &[&str]) -> Result<(), String> {
    if let Some(hook) = value {
        if hook.trim().is_empty() {
            return Err(format!("{field} must be null or a non-empty string."));
        }
        if !installed.contains(&hook.as_str()) {
            return Err(format!("{field} hook {hook:?} is not installed."));
        }
    }
    Ok(())
}

fn validate_monaco_map(
    values: &BTreeMap<String, String>,
    allowed_keys: &[String],
    field: &str,
    case_insensitive: bool,
) -> Result<(), String> {
    let allowed = allowed_keys
        .iter()
        .map(|value| {
            if case_insensitive {
                value.to_ascii_lowercase()
            } else {
                value.clone()
            }
        })
        .collect::<BTreeSet<_>>();
    for (key, value) in values {
        let comparable = if case_insensitive {
            key.to_ascii_lowercase()
        } else {
            key.clone()
        };
        if !allowed.contains(&comparable) {
            return Err(format!("{field} key {key:?} is not declared by this pack."));
        }
        if value.trim().is_empty() {
            return Err(format!("{field}.{key} must be a non-empty string."));
        }
    }
    Ok(())
}

fn insert_unique(
    values: &mut BTreeMap<String, String>,
    value: &str,
    pack_id: &str,
    field: &str,
) -> Result<(), String> {
    if let Some(existing) = values.get(value) {
        if existing != pack_id {
            return Err(conflict_message(field, value, existing, pack_id));
        }
    }
    values.insert(value.to_owned(), pack_id.to_owned());
    Ok(())
}

fn conflict_message(field: &str, value: &str, first: &str, second: &str) -> String {
    format!("Language pack {field} conflict for {value:?} between {first} and {second}.")
}

fn valid_id(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn valid_extension(value: &str) -> bool {
    value.starts_with('.')
        && value.len() > 1
        && value.chars().skip(1).all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '+' | '-')
        })
}

fn valid_semver(value: &str) -> bool {
    let (main, suffix) = value
        .split_once('-')
        .map_or((value, None), |(main, suffix)| (main, Some(suffix)));
    let parts = main.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
        && suffix.is_none_or(|suffix| {
            !suffix.is_empty()
                && suffix.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '-')
                })
        })
}

fn loaded_entry(
    manifest: &LanguagePackManifest,
    origin: LanguagePackOrigin,
    manifest_path: Option<&Path>,
) -> LanguagePackCatalogEntry {
    LanguagePackCatalogEntry::Loaded {
        id: manifest.id.clone(),
        pack_version: manifest.pack_version.clone(),
        origin,
        manifest_path: manifest_path.map(display_path),
        manifest: manifest.clone(),
    }
}

fn error_entry(candidate: &ManifestCandidate, error: CandidateError) -> LanguagePackCatalogEntry {
    let manifest_path = display_path(&candidate.path);
    LanguagePackCatalogEntry::Error {
        error_id: format!("{}:{manifest_path}", origin_name(candidate.origin)),
        origin: candidate.origin,
        manifest_path,
        code: error.code(),
        message: error.to_string(),
    }
}

fn origin_name(origin: LanguagePackOrigin) -> &'static str {
    match origin {
        LanguagePackOrigin::Builtin => "builtin",
        LanguagePackOrigin::User => "user",
        LanguagePackOrigin::Workspace => "workspace",
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/language-pack-sample")
    }

    fn manifest(id: &str, extension: &str) -> LanguagePackManifest {
        LanguagePackManifest {
            schema_version: 1,
            id: id.into(),
            pack_version: "1.0.0".into(),
            extensions: vec![extension.into()],
            basenames: Vec::new(),
            basename_prefixes: Vec::new(),
            monaco: LanguagePackMonacoManifest {
                id: "plaintext".into(),
                highlighter: None,
                by_extension: BTreeMap::new(),
                by_basename: BTreeMap::new(),
                by_basename_prefix: BTreeMap::new(),
            },
            extractors: LanguagePackExtractorManifest {
                source: None,
                workspace: None,
            },
            fixtures: None,
        }
    }

    #[test]
    fn built_in_toml_manifest_uses_v1_schema() {
        let builtins = builtin_language_pack_manifests().unwrap();
        assert_eq!(builtins.len(), 12);
        let toml = builtins
            .iter()
            .find(|manifest| manifest.id == "toml")
            .unwrap();
        assert_eq!(toml.extensions, [".toml"]);
    }

    #[test]
    fn invalid_extension_is_a_validation_error() {
        let mut invalid = manifest("broken", ".broken");
        invalid.extensions = vec!["broken".into()];
        assert_eq!(
            validate_manifest(&invalid).unwrap_err(),
            "extensions[0] must be a lowercase extension beginning with a dot."
        );
    }

    #[test]
    fn whitespace_only_strings_are_validation_errors() {
        let mut invalid = manifest("broken", ".broken");
        invalid.monaco.id = "   ".into();
        assert_eq!(
            validate_manifest(&invalid).unwrap_err(),
            "monaco.id must be a non-empty string."
        );
    }

    #[test]
    fn external_extension_conflict_is_reported_without_replacing_builtin() {
        let directory = TempDir::new().unwrap();
        fs::write(
            directory.path().join("copy.language-pack.json"),
            serde_json::to_vec(&manifest("rust-copy", ".rs")).unwrap(),
        )
        .unwrap();
        let loaded = load_language_packs_with_builtins(
            &[manifest("rust", ".rs")],
            None,
            Some(directory.path()),
            0,
        )
        .unwrap();
        assert_eq!(loaded.manifests.len(), 1);
        let LanguagePackCatalogEntry::Error { code, message, .. } = &loaded.catalog.entries[1]
        else {
            panic!("expected a conflict entry");
        };
        assert_eq!(*code, LanguagePackErrorCode::Conflict);
        assert!(message.contains("extension conflict for \".rs\" between rust and rust-copy"));
    }

    #[test]
    fn sample_workspace_pack_loads_end_to_end() {
        let loaded = load_language_packs_with_builtins(
            &[],
            Some(&sample_root()),
            Some(Path::new("/directory/that/does/not/exist")),
            7,
        )
        .unwrap();
        assert_eq!(loaded.catalog.revision, 7);
        assert_eq!(loaded.manifests.len(), 1);
        assert_eq!(loaded.manifests[0].id, "demo");
        assert_eq!(loaded.manifests[0].extensions, [".demo"]);
    }
}
