//! Links the bundled `lightwell` command onto PATH on macOS.
//!
//! The link is `/usr/local/bin/lightwell` when that directory exists and is
//! writable, and `~/.local/bin/lightwell` otherwise. Shell profiles are not
//! edited. Only symlinks recorded by this module are replaced or removed.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

const LINK_NAME: &str = "lightwell";
const MARKER: &str = ".lightwell-cli-shim.json";
const MARKER_VERSION: u8 = 1;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ManagedLink {
    version: u8,
    target: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallReport {
    link: PathBuf,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoveOutcome {
    Removed,
    Absent,
    Preserved,
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_current_app() -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("current executable: {error}"))?;
    let Some(target) = bundled_cli_from_executable(&executable) else {
        return Ok(());
    };
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "HOME is unset; cannot choose ~/.local/bin".to_string())?;
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err("HOME must be an absolute path".to_string());
    }
    let system_bin = PathBuf::from("/usr/local/bin");
    let local_bin = home.join(".local/bin");
    let path_entries = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    let report = ensure_link_with(
        &target,
        &system_bin,
        &local_bin,
        &path_entries,
        dir_is_writable,
    )?;
    for warning in report.warnings {
        eprintln!("lightwell: warning: {warning}");
    }
    Ok(())
}

fn bundled_cli_from_executable(executable: &Path) -> Option<PathBuf> {
    if executable.file_name()? != LINK_NAME {
        return None;
    }
    let macos = executable.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    if bundle.file_name()? != "Lightwell.app" {
        return None;
    }
    Some(bundle.join("Contents/Resources/bin/lightwell"))
}

fn ensure_link_with(
    target: &Path,
    system_bin: &Path,
    local_bin: &Path,
    path_entries: &[PathBuf],
    system_writable: impl Fn(&Path) -> bool,
) -> Result<InstallReport, String> {
    if !target.is_absolute() {
        return Err("bundled CLI path must be absolute".to_string());
    }
    if !is_bundled_cli(target) {
        return Err(
            "bundled CLI must be Contents/Resources/bin/lightwell inside Lightwell.app".to_string(),
        );
    }
    if !is_executable(target) {
        return Err("bundled CLI is missing or not executable".to_string());
    }

    let use_system_bin = system_bin.is_dir() && system_writable(system_bin);
    let mut candidate_dirs = Vec::new();
    if use_system_bin {
        candidate_dirs.push(system_bin.to_path_buf());
    }
    if !candidate_dirs
        .iter()
        .any(|dir| same_directory(dir, local_bin))
    {
        candidate_dirs.push(local_bin.to_path_buf());
    }

    let mut conflicts = Vec::new();
    for directory in &candidate_dirs {
        if same_directory(directory, local_bin) {
            if let Err(error) = fs::create_dir_all(directory) {
                conflicts.push(format!("cannot create {}: {error}", directory.display()));
                continue;
            }
        }
        if !directory.is_dir() {
            conflicts.push(format!("{} is not a directory", directory.display()));
            continue;
        }

        let link = directory.join(LINK_NAME);
        if managed_or_missing_link(&link) {
            if fs::read_link(&link).is_ok_and(|existing| existing == target) {
                let mut warnings = path_warnings(&link, path_entries);
                cleanup_other_owned_links(
                    &link,
                    use_system_bin.then_some(system_bin),
                    local_bin,
                    &mut warnings,
                );
                return Ok(InstallReport { link, warnings });
            }
            match remove_owned_link(&link) {
                Ok(RemoveOutcome::Removed | RemoveOutcome::Absent) => {}
                Ok(RemoveOutcome::Preserved) => {
                    conflicts.push(format!(
                        "{} is recorded by Lightwell but was left unchanged",
                        link.display()
                    ));
                    continue;
                }
                Err(error) => {
                    conflicts.push(format!(
                        "cannot clear the previous Lightwell link at {}: {error}",
                        link.display()
                    ));
                    continue;
                }
            }
        }

        match fs::symlink_metadata(&link) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if fs::read_link(&link).is_ok_and(|existing| existing == target) {
                    let mut warnings = path_warnings(&link, path_entries);
                    cleanup_other_owned_links(
                        &link,
                        use_system_bin.then_some(system_bin),
                        local_bin,
                        &mut warnings,
                    );
                    return Ok(InstallReport { link, warnings });
                }
                conflicts.push(format!(
                    "{} already points to another lightwell",
                    link.display()
                ));
                continue;
            }
            Ok(_) => {
                conflicts.push(format!(
                    "{} already exists and was left unchanged",
                    link.display()
                ));
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                conflicts.push(format!("cannot inspect {}: {error}", link.display()));
                continue;
            }
        }

        let marker = marker_path(&link);
        match read_record(&marker) {
            Ok(None) => {}
            Ok(Some(_)) => {
                conflicts.push(format!(
                    "{} has a stale or mismatched ownership record",
                    marker.display()
                ));
                continue;
            }
            Err(error) => {
                conflicts.push(format!("cannot read {}: {error}", marker.display()));
                continue;
            }
        }

        if let Err(error) = create_symlink(target, &link) {
            if fs::read_link(&link).is_ok_and(|existing| existing == target) {
                let mut warnings = path_warnings(&link, path_entries);
                cleanup_other_owned_links(
                    &link,
                    use_system_bin.then_some(system_bin),
                    local_bin,
                    &mut warnings,
                );
                return Ok(InstallReport { link, warnings });
            }
            conflicts.push(format!("cannot create {}: {error}", link.display()));
            continue;
        }
        if let Err(error) = write_record(&marker, target) {
            return Err(format!(
                "created {} but could not record ownership ({error}); the link was left in place",
                link.display()
            ));
        }

        let mut warnings = path_warnings(&link, path_entries);
        cleanup_other_owned_links(
            &link,
            use_system_bin.then_some(system_bin),
            local_bin,
            &mut warnings,
        );
        return Ok(InstallReport { link, warnings });
    }

    Err(format!(
        "could not add the bundled lightwell command to PATH. {}",
        conflicts.join("; ")
    ))
}

fn cleanup_other_owned_links(
    installed_link: &Path,
    system_bin: Option<&Path>,
    local_bin: &Path,
    warnings: &mut Vec<String>,
) {
    for directory in system_bin.into_iter().chain([local_bin]) {
        let old_link = directory.join(LINK_NAME);
        if same_path(&old_link, installed_link) || !managed_or_missing_link(&old_link) {
            continue;
        }
        if let Err(error) = remove_owned_link(&old_link) {
            warnings.push(format!(
                "could not remove the previous Lightwell link at {}: {error}",
                old_link.display()
            ));
        }
    }
}

fn path_warnings(link: &Path, path_entries: &[PathBuf]) -> Vec<String> {
    let Some(directory) = link.parent() else {
        return Vec::new();
    };
    let directory_index = path_entries
        .iter()
        .position(|entry| same_directory(entry, directory));
    let mut warnings = Vec::new();
    if directory_index.is_none() {
        warnings.push(format!(
            "the app link is at {}, but that directory is not on PATH. Add it to PATH in your shell configuration. Lightwell did not edit shell profiles.",
            link.display()
        ));
    }

    let earlier = path_entries.iter().enumerate().find_map(|(index, entry)| {
        let executable = entry.join(LINK_NAME);
        is_executable(&executable).then_some((index, executable))
    });
    if let Some((index, executable)) = earlier {
        let resolves_to_link = fs::canonicalize(&executable)
            .ok()
            .zip(fs::canonicalize(link).ok())
            .is_some_and(|(first, installed)| first == installed);
        if !resolves_to_link && directory_index.is_none_or(|shim_index| index < shim_index) {
            warnings.push(format!(
                "{} appears earlier on PATH than {} and will run first. Open a new terminal, or move {} earlier on PATH. Lightwell did not edit shell profiles.",
                executable.display(),
                link.display(),
                directory.display()
            ));
        }
    }
    warnings
}

fn managed_or_missing_link(link: &Path) -> bool {
    let marker = marker_path(link);
    let Ok(Some(record)) = read_record(&marker) else {
        return false;
    };
    if !is_bundled_cli(&record.target) || !record.target.is_absolute() {
        return false;
    }
    match fs::symlink_metadata(link) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::read_link(link).is_ok_and(|target| target == record.target)
        }
        _ => false,
    }
}

fn remove_owned_link(link: &Path) -> Result<RemoveOutcome, String> {
    let marker = marker_path(link);
    let Some(record) = read_record(&marker)? else {
        return Ok(RemoveOutcome::Preserved);
    };
    if record.version != MARKER_VERSION || !is_bundled_cli(&record.target) {
        return Err(format!(
            "invalid Lightwell ownership record at {}",
            marker.display()
        ));
    }

    match fs::symlink_metadata(link) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            remove_marker(&marker)
                .map_err(|error| format!("remove {}: {error}", marker.display()))?;
            Ok(RemoveOutcome::Absent)
        }
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let current =
                fs::read_link(link).map_err(|error| format!("read {}: {error}", link.display()))?;
            if current != record.target {
                remove_marker(&marker)
                    .map_err(|error| format!("remove {}: {error}", marker.display()))?;
                return Ok(RemoveOutcome::Preserved);
            }
            fs::remove_file(link).map_err(|error| {
                format!("remove owned lightwell link {}: {error}", link.display())
            })?;
            remove_marker(&marker)
                .map_err(|error| format!("remove {}: {error}", marker.display()))?;
            Ok(RemoveOutcome::Removed)
        }
        Ok(_) => {
            remove_marker(&marker)
                .map_err(|error| format!("remove {}: {error}", marker.display()))?;
            Ok(RemoveOutcome::Preserved)
        }
        Err(error) => Err(format!("inspect {}: {error}", link.display())),
    }
}

fn read_record(marker: &Path) -> Result<Option<ManagedLink>, String> {
    let metadata = match fs::symlink_metadata(marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect {}: {error}", marker.display())),
    };
    if !metadata.file_type().is_file() {
        return Err(format!("{} is not a regular file", marker.display()));
    }
    let bytes = fs::read(marker).map_err(|error| format!("read {}: {error}", marker.display()))?;
    let record: ManagedLink = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", marker.display()))?;
    if record.version != MARKER_VERSION {
        return Err(format!(
            "unsupported lightwell shim record at {}",
            marker.display()
        ));
    }
    Ok(Some(record))
}

fn write_record(marker: &Path, target: &Path) -> Result<(), String> {
    let parent = marker
        .parent()
        .ok_or_else(|| "lightwell shim marker has no parent".to_string())?;
    let (temp_path, mut file) = loop {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!("{MARKER}.tmp-{}-{id}", std::process::id()));
        match open_private_new(&candidate) {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create {}: {error}", candidate.display())),
        }
    };
    let result = (|| -> Result<(), String> {
        serde_json::to_writer(
            &mut file,
            &ManagedLink {
                version: MARKER_VERSION,
                target: target.to_path_buf(),
            },
        )
        .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        file.flush()
            .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        file.sync_all()
            .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        drop(file);
        fs::rename(&temp_path, marker)
            .map_err(|error| format!("save {}: {error}", marker.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn open_private_new(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

fn create_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

fn remove_marker(marker: &Path) -> io::Result<()> {
    match fs::remove_file(marker) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn marker_path(link: &Path) -> PathBuf {
    link.parent().unwrap_or(Path::new(".")).join(MARKER)
}

fn is_bundled_cli(path: &Path) -> bool {
    let Some(bin) = path.parent() else {
        return false;
    };
    let Some(resources) = bin.parent() else {
        return false;
    };
    let Some(contents) = resources.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    path.file_name().is_some_and(|name| name == LINK_NAME)
        && bin.file_name().is_some_and(|name| name == "bin")
        && resources
            .file_name()
            .is_some_and(|name| name == "Resources")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .file_name()
            .is_some_and(|name| name == "Lightwell.app")
}

fn dir_is_writable(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let probe = path.join(format!(
        ".lightwell-write-probe-{}-{id}",
        std::process::id()
    ));
    match open_private_new(&probe) {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn same_directory(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left)
        .ok()
        .zip(fs::canonicalize(right).ok())
        .is_some_and(|(left, right)| left == right)
        || (!left.exists() && !right.exists() && normalize(left) == normalize(right))
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize(left) == normalize(right)
}

fn normalize(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "lightwell-path-shim-test-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn app_cli(root: &Path) -> PathBuf {
        let cli = root.join("Lightwell.app/Contents/Resources/bin/lightwell");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, b"lightwell-cli").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        cli
    }

    fn executable_file(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn writable_system_bin_gets_the_link() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();

        let report = ensure_link_with(
            &target,
            &system,
            &local,
            std::slice::from_ref(&system),
            |_| true,
        )
        .unwrap();

        assert_eq!(report.link, system.join(LINK_NAME));
        assert_eq!(fs::read_link(&report.link).unwrap(), target);
        assert!(managed_or_missing_link(&report.link));
        assert!(!local.join(LINK_NAME).exists());
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn repeated_launch_keeps_the_existing_owned_link() {
        use std::os::unix::fs::MetadataExt;

        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let entries = [system.clone()];

        let first = ensure_link_with(&target, &system, &local, &entries, |_| true).unwrap();
        let first_inode = fs::symlink_metadata(&first.link).unwrap().ino();
        let second = ensure_link_with(&target, &system, &local, &entries, |_| true).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            fs::symlink_metadata(&second.link).unwrap().ino(),
            first_inode
        );
    }

    #[test]
    fn missing_system_bin_uses_local_and_does_not_create_system() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");

        let report = ensure_link_with(
            &target,
            &system,
            &local,
            std::slice::from_ref(&local),
            |_| true,
        )
        .unwrap();

        assert!(!system.exists());
        assert_eq!(report.link, local.join(LINK_NAME));
        assert_eq!(fs::read_link(&report.link).unwrap(), target);
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn unwritable_system_bin_falls_back_to_local_bin() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();

        let report = ensure_link_with(
            &target,
            &system,
            &local,
            std::slice::from_ref(&local),
            |_| false,
        )
        .unwrap();

        assert_eq!(report.link, local.join(LINK_NAME));
        assert_eq!(fs::read_link(&report.link).unwrap(), target);
        assert!(!system.join(LINK_NAME).exists());
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn warns_when_the_fallback_bin_dir_is_not_on_path() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();

        let report = ensure_link_with(&target, &system, &local, &[], |_| false).unwrap();

        assert_eq!(report.link, local.join(LINK_NAME));
        assert!(report.warnings.iter().any(|warning| {
            warning.contains("not on PATH") && warning.contains("did not edit shell profiles")
        }));
    }

    #[test]
    fn unwritable_system_bin_does_not_remove_its_existing_owned_link() {
        let tmp = Scratch::new();
        let old_target = app_cli(&tmp.path().join("old"));
        let new_target = app_cli(&tmp.path().join("new"));
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let old = ensure_link_with(
            &old_target,
            &system,
            &local,
            std::slice::from_ref(&system),
            |_| true,
        )
        .unwrap();

        let new = ensure_link_with(
            &new_target,
            &system,
            &local,
            std::slice::from_ref(&local),
            |_| false,
        )
        .unwrap();

        assert_eq!(new.link, local.join(LINK_NAME));
        assert_eq!(fs::read_link(&old.link).unwrap(), old_target);
        assert!(marker_path(&old.link).exists());
    }

    #[test]
    fn installing_in_system_bin_removes_the_older_owned_local_link() {
        let tmp = Scratch::new();
        let old_target = app_cli(&tmp.path().join("old"));
        let new_target = app_cli(&tmp.path().join("new"));
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let old = ensure_link_with(
            &old_target,
            &system,
            &local,
            std::slice::from_ref(&local),
            |_| false,
        )
        .unwrap();

        let new = ensure_link_with(
            &new_target,
            &system,
            &local,
            std::slice::from_ref(&system),
            |_| true,
        )
        .unwrap();

        assert_eq!(new.link, system.join(LINK_NAME));
        assert_eq!(fs::read_link(&new.link).unwrap(), new_target);
        assert!(!old.link.exists());
        assert!(!marker_path(&old.link).exists());
        assert!(old_target.exists());
    }

    #[test]
    fn earlier_lightwell_on_path_is_left_in_place_and_warned() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let earlier_dir = tmp.path().join("home/.cargo/bin");
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let earlier = earlier_dir.join(LINK_NAME);
        executable_file(&earlier, b"other lightwell");

        let report = ensure_link_with(
            &target,
            &system,
            &local,
            &[earlier_dir, system.clone()],
            |_| true,
        )
        .unwrap();

        assert_eq!(report.link, system.join(LINK_NAME));
        assert_eq!(fs::read(&earlier).unwrap(), b"other lightwell");
        assert!(report.warnings.iter().any(|warning| {
            warning.contains(&earlier.display().to_string())
                && warning.contains("will run first")
                && warning.contains("did not edit shell profiles")
        }));
    }

    #[test]
    fn system_bin_file_is_preserved_and_local_bin_is_used() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let existing = system.join(LINK_NAME);
        executable_file(&existing, b"existing command");

        let report = ensure_link_with(
            &target,
            &system,
            &local,
            &[system.clone(), local.clone()],
            |_| true,
        )
        .unwrap();

        assert_eq!(report.link, local.join(LINK_NAME));
        assert_eq!(fs::read(&existing).unwrap(), b"existing command");
        assert!(report.warnings.iter().any(|warning| {
            warning.contains(&existing.display().to_string()) && warning.contains("will run first")
        }));
    }

    #[test]
    fn cleanup_does_not_remove_an_unowned_local_lightwell() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let foreign = local.join(LINK_NAME);
        executable_file(&foreign, b"manual install");

        let report = ensure_link_with(
            &target,
            &system,
            &local,
            std::slice::from_ref(&system),
            |_| true,
        )
        .unwrap();

        assert_eq!(report.link, system.join(LINK_NAME));
        assert_eq!(fs::read(&foreign).unwrap(), b"manual install");
        assert!(!marker_path(&foreign).exists());
    }

    #[test]
    fn owned_link_follows_a_moved_app() {
        let tmp = Scratch::new();
        let old_target = app_cli(&tmp.path().join("old"));
        let new_target = app_cli(&tmp.path().join("new"));
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let entries = [system.clone()];

        let first = ensure_link_with(&old_target, &system, &local, &entries, |_| true).unwrap();
        let second = ensure_link_with(&new_target, &system, &local, &entries, |_| true).unwrap();

        assert_eq!(first.link, second.link);
        assert_eq!(fs::read_link(&second.link).unwrap(), new_target);
        assert_ne!(fs::read_link(&second.link).unwrap(), old_target);
        assert!(old_target.exists());
        let record = read_record(&marker_path(&second.link)).unwrap().unwrap();
        assert_eq!(record.target, new_target);
    }

    #[test]
    fn remove_owned_link_removes_only_the_owned_link_and_keeps_the_cli() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let report = ensure_link_with(
            &target,
            &system,
            &local,
            std::slice::from_ref(&system),
            |_| true,
        )
        .unwrap();

        assert!(managed_or_missing_link(&report.link));
        assert_eq!(
            remove_owned_link(&report.link).unwrap(),
            RemoveOutcome::Removed
        );
        assert!(!report.link.exists());
        assert!(!marker_path(&report.link).exists());
        assert!(target.exists());
    }

    #[test]
    fn remove_owned_link_leaves_an_unowned_lightwell_untouched() {
        let tmp = Scratch::new();
        let link = tmp.path().join("home/.local/bin/lightwell");
        executable_file(&link, b"a separate lightwell install");

        assert!(!managed_or_missing_link(&link));
        assert_eq!(remove_owned_link(&link).unwrap(), RemoveOutcome::Preserved);
        assert_eq!(fs::read(&link).unwrap(), b"a separate lightwell install");
    }

    #[test]
    fn remove_owned_link_preserves_a_link_retargeted_after_install() {
        let tmp = Scratch::new();
        let target = app_cli(tmp.path());
        let other = tmp.path().join("other/lightwell");
        executable_file(&other, b"replacement");
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();
        let report = ensure_link_with(
            &target,
            &system,
            &local,
            std::slice::from_ref(&system),
            |_| true,
        )
        .unwrap();
        fs::remove_file(&report.link).unwrap();
        create_symlink(&other, &report.link).unwrap();

        assert!(!managed_or_missing_link(&report.link));
        assert_eq!(
            remove_owned_link(&report.link).unwrap(),
            RemoveOutcome::Preserved
        );
        assert_eq!(fs::read_link(&report.link).unwrap(), other);
        assert!(!marker_path(&report.link).exists());
        assert!(target.exists());
    }

    #[test]
    fn gui_binary_is_not_used_as_the_path_target() {
        let tmp = Scratch::new();
        let gui = tmp.path().join("Lightwell.app/Contents/MacOS/lightwell");
        executable_file(&gui, b"gui");
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();

        let error = ensure_link_with(&gui, &system, &local, &[], |_| true).unwrap_err();

        assert!(error.contains("Contents/Resources/bin/lightwell"));
        assert!(!system.join(LINK_NAME).exists());
        assert!(!local.exists());
    }

    #[test]
    fn missing_cli_binary_does_not_create_a_link() {
        let tmp = Scratch::new();
        let target = tmp
            .path()
            .join("Lightwell.app/Contents/Resources/bin/lightwell");
        let system = tmp.path().join("usr-local-bin");
        let local = tmp.path().join("home/.local/bin");
        fs::create_dir_all(&system).unwrap();

        let error = ensure_link_with(&target, &system, &local, &[], |_| true).unwrap_err();

        assert!(error.contains("missing or not executable"));
        assert!(!system.join(LINK_NAME).exists());
    }

    #[test]
    fn executable_inside_the_app_selects_the_bundled_cli() {
        let app = Path::new("/tmp/Lightwell.app");
        assert_eq!(
            bundled_cli_from_executable(&app.join("Contents/MacOS/lightwell")),
            Some(app.join("Contents/Resources/bin/lightwell"))
        );
        assert_eq!(
            bundled_cli_from_executable(Path::new("/tmp/lightwell")),
            None
        );
        assert_eq!(
            bundled_cli_from_executable(&app.join("Contents/Resources/bin/lightwell")),
            None
        );
    }

    #[test]
    fn dir_is_writable_rejects_a_read_only_directory() {
        let tmp = Scratch::new();
        let dir = tmp.path().join("locked");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let writable = dir_is_writable(&dir);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(!writable);
        assert!(dir_is_writable(&dir));
    }

    #[test]
    #[ignore = "invoked by scripts/ci/test-macos-cli-path.sh"]
    fn shell_proof_installs_resolvable_link() {
        let app = PathBuf::from(
            std::env::var("LIGHTWELL_SHIM_PROOF_APP").expect("LIGHTWELL_SHIM_PROOF_APP"),
        );
        let system = PathBuf::from(
            std::env::var("LIGHTWELL_SHIM_PROOF_SYSTEM").expect("LIGHTWELL_SHIM_PROOF_SYSTEM"),
        );
        let home = PathBuf::from(
            std::env::var("LIGHTWELL_SHIM_PROOF_HOME").expect("LIGHTWELL_SHIM_PROOF_HOME"),
        );
        let writable = std::env::var("LIGHTWELL_SHIM_PROOF_SYSTEM_WRITABLE")
            .expect("LIGHTWELL_SHIM_PROOF_SYSTEM_WRITABLE")
            == "1";
        let target = app.join("Contents/Resources/bin/lightwell");
        let gui = app.join("Contents/MacOS/lightwell");
        let local = home.join(".local/bin");
        let entries = [system.clone(), local.clone()];

        let report = ensure_link_with(&target, &system, &local, &entries, |_| writable)
            .expect("install bundled CLI link");

        let expected = if writable {
            system.join(LINK_NAME)
        } else {
            local.join(LINK_NAME)
        };
        assert_eq!(report.link, expected);
        assert_eq!(fs::read_link(&report.link).unwrap(), target);
        assert_ne!(fs::read_link(&report.link).unwrap(), gui);
        assert!(managed_or_missing_link(&report.link));
    }
}
