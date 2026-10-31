use lightwell_core::{
    load_language_packs, read_language_pack_manifest, validate_language_pack_conflicts,
    LanguagePackCatalog, LanguagePackCatalogEntry, LanguagePackManifest, LanguagePackOrigin,
    LoadedLanguagePacks,
};
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

const CATALOG_CHANGED_EVENT: &str = "language-pack-catalog-changed";

#[derive(Default)]
pub struct LanguagePackService {
    revision: Mutex<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LanguagePackInstallSource {
    Catalog { id: String },
    Path { path: String },
}

#[tauri::command(async)]
pub fn language_pack_catalog(
    app: AppHandle,
    service: State<'_, LanguagePackService>,
    workspace_id: Option<String>,
) -> Result<LanguagePackCatalog, String> {
    load_catalog(&app, service.inner(), workspace_id.as_deref()).map(|loaded| loaded.catalog)
}

#[tauri::command(async)]
pub fn validate_language_pack(
    app: AppHandle,
    source: LanguagePackInstallSource,
) -> Result<LanguagePackManifest, String> {
    let manifest_path = resolve_install_source(&app, &source)?;
    read_language_pack_manifest(&manifest_path)
}

#[tauri::command(async)]
pub fn install_language_pack(
    app: AppHandle,
    service: State<'_, LanguagePackService>,
    source: LanguagePackInstallSource,
    replace: bool,
    workspace_id: Option<String>,
) -> Result<LanguagePackCatalog, String> {
    let source_path = resolve_install_source(&app, &source)?;
    let manifest = read_language_pack_manifest(&source_path)?;
    let loaded = load_catalog(&app, service.inner(), workspace_id.as_deref())?;
    validate_install(&loaded, &manifest, replace)?;
    let user_directory = user_packs_directory(&app)?;
    let destination_directory = user_directory.join(&manifest.id);
    let destination = destination_directory.join("language-pack.json");
    copy_manifest_atomic(&source_path, &destination, replace)?;
    refreshed_catalog(&app, service.inner(), workspace_id.as_deref())
}

#[tauri::command(async)]
pub fn reload_language_packs(
    app: AppHandle,
    service: State<'_, LanguagePackService>,
    workspace_id: Option<String>,
) -> Result<LanguagePackCatalog, String> {
    refreshed_catalog(&app, service.inner(), workspace_id.as_deref())
}

#[tauri::command(async)]
pub fn remove_language_pack(
    app: AppHandle,
    service: State<'_, LanguagePackService>,
    id: String,
    workspace_id: Option<String>,
) -> Result<LanguagePackCatalog, String> {
    validate_catalog_id(&id)?;
    let loaded = load_catalog(&app, service.inner(), workspace_id.as_deref())?;
    let removable = loaded.catalog.entries.iter().any(|entry| {
        matches!(entry, LanguagePackCatalogEntry::Loaded {
            id: loaded_id,
            origin: LanguagePackOrigin::User,
            ..
        } if loaded_id == &id)
    });
    if !removable {
        return Err(format!(
            "Language pack {id} is not installed in the user language packs directory."
        ));
    }
    let directory = user_packs_directory(&app)?.join(&id);
    let manifest_path = directory.join("language-pack.json");
    fs::remove_file(&manifest_path).map_err(|error| {
        format!(
            "Could not remove language pack manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    match fs::remove_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => {}
        Err(error) => {
            return Err(format!(
                "Could not remove language pack directory {}: {error}",
                directory.display()
            ))
        }
    }
    refreshed_catalog(&app, service.inner(), workspace_id.as_deref())
}

#[tauri::command(async)]
pub fn open_language_packs_directory(app: AppHandle) -> Result<(), String> {
    let directory = user_packs_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Could not create language pack directory {}: {error}",
            directory.display()
        )
    })?;
    open_directory(&directory)
}

fn load_catalog(
    app: &AppHandle,
    service: &LanguagePackService,
    workspace_id: Option<&str>,
) -> Result<LoadedLanguagePacks, String> {
    let workspace_root = workspace_id
        .map(Path::new)
        .map(|path| {
            path.canonicalize().map_err(|error| {
                format!(
                    "Could not resolve workspace folder {}: {error}",
                    path.display()
                )
            })
        })
        .transpose()?;
    let user_directory = user_packs_directory(app)?;
    let revision = *service
        .revision
        .lock()
        .map_err(|_| "The language pack catalog lock is unavailable.".to_owned())?;
    load_language_packs(workspace_root.as_deref(), Some(&user_directory), revision)
        .map_err(|error| error.to_string())
}

fn refreshed_catalog(
    app: &AppHandle,
    service: &LanguagePackService,
    workspace_id: Option<&str>,
) -> Result<LanguagePackCatalog, String> {
    {
        let mut revision = service
            .revision
            .lock()
            .map_err(|_| "The language pack catalog lock is unavailable.".to_owned())?;
        *revision = revision.saturating_add(1);
    }
    let catalog = load_catalog(app, service, workspace_id)?.catalog;
    app.emit(CATALOG_CHANGED_EVENT, &catalog)
        .map_err(|error| format!("Could not publish the language pack catalog: {error}"))?;
    Ok(catalog)
}

fn validate_install(
    loaded: &LoadedLanguagePacks,
    manifest: &LanguagePackManifest,
    replace: bool,
) -> Result<(), String> {
    if loaded.catalog.entries.iter().any(|entry| {
        matches!(entry, LanguagePackCatalogEntry::Loaded {
            id,
            origin: LanguagePackOrigin::Builtin,
            ..
        } if id == &manifest.id)
    }) {
        return Err(format!(
            "Language pack {} is built in and cannot be replaced.",
            manifest.id
        ));
    }
    let installed_user_pack = loaded.catalog.entries.iter().any(|entry| {
        matches!(entry, LanguagePackCatalogEntry::Loaded {
            id,
            origin: LanguagePackOrigin::User,
            ..
        } if id == &manifest.id)
    });
    if installed_user_pack && !replace {
        return Err(format!(
            "Language pack {} is already installed. Set replace to update it.",
            manifest.id
        ));
    }
    let workspace_pack = loaded.catalog.entries.iter().any(|entry| {
        matches!(entry, LanguagePackCatalogEntry::Loaded {
            id,
            origin: LanguagePackOrigin::Workspace,
            ..
        } if id == &manifest.id)
    });
    if workspace_pack {
        return Err(format!(
            "Language pack {} conflicts with a workspace language pack.",
            manifest.id
        ));
    }
    let mut manifests = loaded
        .catalog
        .entries
        .iter()
        .filter_map(|entry| match entry {
            LanguagePackCatalogEntry::Loaded {
                id,
                origin: LanguagePackOrigin::User,
                ..
            } if replace && id == &manifest.id => None,
            LanguagePackCatalogEntry::Loaded { manifest, .. } => Some(manifest.clone()),
            LanguagePackCatalogEntry::Error { .. } => None,
        })
        .collect::<Vec<_>>();
    manifests.push(manifest.clone());
    validate_language_pack_conflicts(&manifests)
}

fn resolve_install_source(
    app: &AppHandle,
    source: &LanguagePackInstallSource,
) -> Result<PathBuf, String> {
    match source {
        LanguagePackInstallSource::Catalog { id } => {
            validate_catalog_id(id)?;
            app.path()
                .resolve(
                    Path::new("language-packs")
                        .join(id)
                        .join("language-pack.json"),
                    BaseDirectory::Resource,
                )
                .map_err(|error| format!("Could not locate bundled language pack {id}: {error}"))
        }
        LanguagePackInstallSource::Path { path } => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("Language pack source paths must be absolute.".to_owned());
            }
            Ok(if path.is_dir() {
                path.join("language-pack.json")
            } else {
                path
            })
        }
    }
}

fn validate_catalog_id(id: &str) -> Result<(), String> {
    let mut characters = id.chars();
    let valid = characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if valid {
        Ok(())
    } else {
        Err("Language pack IDs must use lowercase letters, digits, and hyphens.".to_owned())
    }
}

fn user_packs_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("language-packs"))
        .map_err(|error| format!("Could not locate Lightwell's user config folder: {error}"))
}

fn copy_manifest_atomic(source: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    let directory = destination
        .parent()
        .ok_or_else(|| "The language pack destination has no parent directory.".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "Could not create language pack directory {}: {error}",
            directory.display()
        )
    })?;
    if destination.exists() && !replace {
        return Err(format!(
            "Language pack manifest {} already exists.",
            destination.display()
        ));
    }
    let bytes = fs::read(source).map_err(|error| {
        format!(
            "Could not read language pack manifest {}: {error}",
            source.display()
        )
    })?;
    let temporary = destination.with_extension("json.tmp");
    let backup = destination.with_extension("json.bak");
    fs::write(&temporary, bytes).map_err(|error| {
        format!(
            "Could not stage language pack manifest {}: {error}",
            temporary.display()
        )
    })?;
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                format!(
                    "Could not remove stale language pack backup {}: {error}",
                    backup.display()
                )
            })?;
        }
        fs::rename(destination, &backup).map_err(|error| {
            format!(
                "Could not replace language pack manifest {}: {error}",
                destination.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(format!(
            "Could not install language pack manifest {}: {error}",
            destination.display()
        ));
    }
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Language pack installed, but its backup {} could not be removed: {error}",
                backup.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_directory(path: &Path) -> Result<(), String> {
    launch_directory("open", path)
}

#[cfg(target_os = "windows")]
fn open_directory(path: &Path) -> Result<(), String> {
    launch_directory("explorer", path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(path: &Path) -> Result<(), String> {
    launch_directory("xdg-open", path)
}

fn launch_directory(program: &str, path: &Path) -> Result<(), String> {
    Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Could not open language pack directory {}: {error}",
                path.display()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn catalog_ids_cannot_escape_the_resource_directory() {
        assert!(validate_catalog_id("demo-pack").is_ok());
        assert_eq!(
            validate_catalog_id("../demo").unwrap_err(),
            "Language pack IDs must use lowercase letters, digits, and hyphens."
        );
    }

    #[test]
    fn install_source_deserializes_the_catalog_contract() {
        let source: LanguagePackInstallSource = serde_json::from_value(serde_json::json!({
            "kind": "catalog",
            "id": "demo"
        }))
        .unwrap();
        assert_eq!(
            source,
            LanguagePackInstallSource::Catalog { id: "demo".into() }
        );
    }

    #[test]
    fn manifest_copy_requires_replace_and_writes_the_new_contents() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "lightwell-language-pack-copy-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let source = directory.join("source.json");
        let destination = directory.join("installed/language-pack.json");
        fs::write(&source, "first").unwrap();
        copy_manifest_atomic(&source, &destination, false).unwrap();
        fs::write(&source, "second").unwrap();
        assert!(copy_manifest_atomic(&source, &destination, false)
            .unwrap_err()
            .contains("already exists"));
        copy_manifest_atomic(&source, &destination, true).unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "second");
        fs::remove_dir_all(directory).unwrap();
    }
}
