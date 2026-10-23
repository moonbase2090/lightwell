use super::{
    NotesDocument, ProjectNote, ProjectNotesStore, NEXT_TEMP_FILE_ID, NOTES_SCHEMA_VERSION,
};
use crate::metadata::without_console_window;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NotesGitStatus {
    NotRepository,
    Missing,
    Ignored,
    Conflicted,
    Unavailable {
        message: String,
    },
    Ready {
        state: NotesGitFileState,
        revision: String,
        note_changed: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotesGitFileState {
    Clean,
    Untracked,
    Modified,
    Staged,
    Mixed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCommitResult {
    pub commit_id: Option<String>,
    pub status: NotesGitStatus,
}

struct Repository {
    root: PathBuf,
    relative: PathBuf,
}

impl Repository {
    fn command(&self, index: Option<&Path>) -> Command {
        let mut command = without_console_window(Command::new("git"));
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
        ] {
            command.env_remove(key);
        }
        command.args(["--literal-pathspecs", "-C"]).arg(&self.root);
        command.env("GIT_OPTIONAL_LOCKS", "0");
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        command
    }

    fn run(
        &self,
        index: Option<&Path>,
        args: &[&OsStr],
        input: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        let mut command = self.command(index);
        command
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if input.is_some() {
            command.stdin(Stdio::piped());
        } else {
            command.stdin(Stdio::null());
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not run Git: {e}. Install Git and retry."))?;
        if let Some(input) = input {
            child
                .stdin
                .take()
                .ok_or("Git input unavailable")?
                .write_all(input)
                .map_err(|e| e.to_string())?;
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        Ok(output.stdout)
    }

    fn simple(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        self.run(None, &args.iter().map(OsStr::new).collect::<Vec<_>>(), None)
    }

    fn document(&self, index: Option<&Path>) -> Result<(NotesDocument, String), String> {
        let listing = if let Some(index) = index {
            self.run(
                Some(index),
                &[
                    OsStr::new("ls-files"),
                    OsStr::new("--stage"),
                    OsStr::new("-z"),
                    OsStr::new("--"),
                    self.relative.as_os_str(),
                ],
                None,
            )?
        } else {
            if self.simple(&["rev-parse", "--verify", "HEAD"]).is_err() {
                return Ok((NotesDocument::default(), "100644".into()));
            }
            self.run(
                None,
                &[
                    OsStr::new("ls-tree"),
                    OsStr::new("-z"),
                    OsStr::new("HEAD"),
                    OsStr::new("--"),
                    self.relative.as_os_str(),
                ],
                None,
            )?
        };
        if listing.is_empty() {
            return Ok((NotesDocument::default(), "100644".into()));
        }
        let metadata = listing
            .split(|b| *b == b'\t')
            .next()
            .ok_or("Invalid Git entry")?;
        let metadata = std::str::from_utf8(metadata).map_err(|e| e.to_string())?;
        let fields: Vec<_> = metadata.split_whitespace().collect();
        let (mode, hash) = match fields.as_slice() {
            [mode, "blob", hash] if index.is_none() => (*mode, *hash),
            [mode, hash, "0"] if index.is_some() => (*mode, *hash),
            _ => return Err("Resolve the notes merge conflict in Git before committing.".into()),
        };
        if mode != "100644" && mode != "100755" {
            return Err("Notes must be a regular file, not a Git symlink.".into());
        }
        let bytes = self.simple(&["cat-file", "blob", hash])?;
        let document: NotesDocument = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Git contains invalid notes JSON: {e}"))?;
        if document.schema_version != NOTES_SCHEMA_VERSION {
            return Err("Git contains an unsupported notes schema.".into());
        }
        Ok((document, mode.into()))
    }

    fn write_entry(
        &self,
        index: &Path,
        mut document: NotesDocument,
        mode: &str,
        block_id: &str,
        note: &ProjectNote,
    ) -> Result<(), String> {
        document.notes.insert(block_id.to_owned(), note.clone());
        let mut bytes = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let hash = self.run(
            None,
            &[
                OsStr::new("hash-object"),
                OsStr::new("-w"),
                OsStr::new("--stdin"),
                OsStr::new("--path"),
                self.relative.as_os_str(),
            ],
            Some(&bytes),
        )?;
        let hash = std::str::from_utf8(&hash)
            .map_err(|e| e.to_string())?
            .trim();
        self.run(
            Some(index),
            &[
                OsStr::new("update-index"),
                OsStr::new("--add"),
                OsStr::new("--cacheinfo"),
                OsStr::new(mode),
                OsStr::new(hash),
                self.relative.as_os_str(),
            ],
            None,
        )?;
        Ok(())
    }
}

fn repository(store: &ProjectNotesStore) -> Result<Option<Repository>, String> {
    let parent = store
        .path
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid notes path")?;
    let probe = Repository {
        root: parent.to_owned(),
        relative: PathBuf::new(),
    };
    let root = match probe.simple(&["rev-parse", "--show-toplevel"]) {
        Ok(bytes) => PathBuf::from(
            String::from_utf8(bytes)
                .map_err(|e| e.to_string())?
                .trim_end(),
        ),
        Err(message) if message.contains("not a git repository") => return Ok(None),
        Err(message) => return Err(message),
    };
    let path = parent
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(store.path.strip_prefix(parent).map_err(|e| e.to_string())?);
    let existing = if path.exists() {
        path.as_path()
    } else {
        path.parent().ok_or("Invalid notes path")?
    };
    if existing.exists() && existing.canonicalize().map_err(|e| e.to_string())? != existing {
        return Err(
            "Notes Git actions require a regular notes file without symlinked directories.".into(),
        );
    }
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| "Notes are outside the Git repository")?
        .to_owned();
    Ok(Some(Repository { root, relative }))
}

fn revision(path: &Path) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(|e| e.to_string())?)
    ))
}

fn inspect(store: &ProjectNotesStore, block_id: &str) -> Result<NotesGitStatus, String> {
    let Some(repo) = repository(store)? else {
        return Ok(NotesGitStatus::NotRepository);
    };
    if !store.path.is_file() {
        return Ok(NotesGitStatus::Missing);
    }
    let output = repo.run(
        None,
        &[
            OsStr::new("status"),
            OsStr::new("--porcelain=v1"),
            OsStr::new("-z"),
            OsStr::new("--ignored"),
            OsStr::new("--untracked-files=all"),
            OsStr::new("--"),
            repo.relative.as_os_str(),
        ],
        None,
    )?;
    let xy = output.get(..2).unwrap_or(b"  ");
    if xy == b"!!" {
        return Ok(NotesGitStatus::Ignored);
    }
    if xy.contains(&b'U') || xy == b"AA" || xy == b"DD" {
        return Ok(NotesGitStatus::Conflicted);
    }
    let state = match xy {
        b"??" => NotesGitFileState::Untracked,
        b"  " => NotesGitFileState::Clean,
        [b' ', _] => NotesGitFileState::Modified,
        [_, b' '] => NotesGitFileState::Staged,
        _ => NotesGitFileState::Mixed,
    };
    let current = store.read_document().map_err(|e| e.to_string())?;
    let (head, _) = repo.document(None)?;
    Ok(NotesGitStatus::Ready {
        state,
        revision: revision(&store.path)?,
        note_changed: current.notes.get(block_id) != head.notes.get(block_id),
    })
}

/// Reads Git state without creating notes files, locks, or ignore rules.
pub fn project_note_git_status(root: &Path, block_id: &str) -> NotesGitStatus {
    inspect(&ProjectNotesStore::new(root), block_id)
        .unwrap_or_else(|message| NotesGitStatus::Unavailable { message })
}

struct OwnedPath {
    path: PathBuf,
    directory: bool,
}
impl Drop for OwnedPath {
    fn drop(&mut self) {
        if self.directory {
            let _ = fs::remove_dir_all(&self.path);
        } else {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Commits only the selected saved entry and preserves the working file and unrelated staging.
pub fn commit_project_note(
    root: &Path,
    block_id: &str,
    expected_revision: &str,
    text: &str,
    source_fingerprint: &str,
) -> Result<NoteCommitResult, String> {
    let store = ProjectNotesStore::new(root);
    // Validate the storage boundary before opening the notes lock.
    repository(&store)?
        .ok_or("This project is not in a Git repository. Initialize Git to share notes.")?;
    let mut outcome = Err("Save this note before committing it.".to_owned());
    store
        .update(false, |document| {
            outcome = commit_locked(
                &store,
                document,
                block_id,
                expected_revision,
                text,
                source_fingerprint,
            );
            Ok(false)
        })
        .map_err(|e| e.to_string())?;
    outcome
}

fn commit_locked(
    store: &ProjectNotesStore,
    current: &NotesDocument,
    block_id: &str,
    expected_revision: &str,
    text: &str,
    source_fingerprint: &str,
) -> Result<NoteCommitResult, String> {
    let status = inspect(store, block_id)?;
    if !matches!(status, NotesGitStatus::Ready { .. }) {
        return Err(match status {
            NotesGitStatus::Ignored => {
                "The notes file is ignored. Change your Git ignore rules before committing."
            }
            NotesGitStatus::Conflicted => {
                "Resolve the notes merge conflict in Git before committing."
            }
            _ => "Notes are not ready to commit. Refresh their Git status and retry.",
        }
        .into());
    }
    if revision(&store.path)? != expected_revision {
        return Err("Notes changed since the last refresh. Refresh and review the saved note before retrying.".into());
    }
    let selected = current
        .notes
        .get(block_id)
        .ok_or("This note no longer exists. Refresh the notes list.")?;
    if selected.text != text || selected.source_fingerprint != source_fingerprint {
        return Err("The saved note changed. Refresh and review it before committing.".into());
    }
    let repo = repository(store)?.ok_or("This project is not in a Git repository.")?;
    let index_output = repo.simple(&["rev-parse", "--git-path", "index"])?;
    let index = PathBuf::from(
        String::from_utf8(index_output)
            .map_err(|e| e.to_string())?
            .trim_end(),
    );
    let index = if index.is_absolute() {
        index
    } else {
        repo.root.join(index)
    };
    let lock = index.with_file_name("index.lock");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|e| {
            format!("Cannot lock the Git index: {e}. Finish other Git operations and retry.")
        })?;
    let _lock = OwnedPath {
        path: lock.clone(),
        directory: false,
    };
    let (head_document, head_mode) = repo.document(None)?;
    if head_document.notes.get(block_id) == Some(selected) {
        return Ok(NoteCommitResult {
            commit_id: None,
            status,
        });
    }
    let directory = loop {
        let sequence = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = index
            .parent()
            .ok_or("Missing Git directory")?
            .join(format!("lightwell-note-{}-{sequence}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    };
    let _directory = OwnedPath {
        path: directory.clone(),
        directory: true,
    };
    let isolated = directory.join("index");
    if index.exists() {
        fs::copy(&index, &lock).map_err(|e| e.to_string())?;
    } else {
        repo.run(
            Some(&isolated),
            &[OsStr::new("read-tree"), OsStr::new("--empty")],
            None,
        )?;
        fs::copy(&isolated, &lock).map_err(|e| e.to_string())?;
    }
    let (staged_document, staged_mode) = repo.document(Some(&lock))?;
    repo.write_entry(&lock, staged_document, &staged_mode, block_id, selected)?;
    let tree = if repo.simple(&["rev-parse", "--verify", "HEAD"]).is_ok() {
        "HEAD"
    } else {
        "--empty"
    };
    repo.run(
        Some(&isolated),
        &[OsStr::new("read-tree"), OsStr::new(tree)],
        None,
    )?;
    repo.write_entry(&isolated, head_document, &head_mode, block_id, selected)?;
    repo.run(
        Some(&isolated),
        &[
            OsStr::new("commit"),
            OsStr::new("-m"),
            OsStr::new("Update project note"),
        ],
        None,
    )
    .map_err(|e| format!("Note is saved, but Git could not commit it: {e}"))?;
    let commit_id = String::from_utf8(repo.simple(&["rev-parse", "HEAD"])?)
        .map_err(|e| e.to_string())?
        .trim()
        .to_owned();
    let status = match fs::rename(&lock, &index) {
        Ok(()) => project_note_git_status(store.path.parent().and_then(Path::parent).ok_or("Invalid notes path")?, block_id),
        Err(e) => NotesGitStatus::Unavailable { message: format!("Commit {commit_id} was created, but the Git index could not be restored: {e}. Inspect Git status before continuing.") },
    };
    Ok(NoteCommitResult {
        commit_id: Some(commit_id),
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(git: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "lightwell-note-git-test-{}-{}",
                std::process::id(),
                NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let fixture = Self { root };
            if git {
                fixture.git(&["init", "-q"]);
                fixture.git(&["config", "user.name", "Note Test"]);
                fixture.git(&["config", "user.email", "notes@example.invalid"]);
                fixture.git(&["config", "commit.gpgsign", "false"]);
                fixture.git(&["config", "core.hooksPath", "/dev/null"]);
            }
            fixture
        }
        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        }
        fn save(&self, id: &str, text: &str) {
            ProjectNotesStore::new(&self.root)
                .set(id, text, "fingerprint")
                .unwrap();
        }
        fn commit(&self, id: &str, text: &str) -> Result<NoteCommitResult, String> {
            commit_project_note(
                &self.root,
                id,
                &revision(&ProjectNotesStore::new(&self.root).path).unwrap(),
                text,
                "fingerprint",
            )
        }
        fn head_notes(&self) -> NotesDocument {
            serde_json::from_str(&self.git(&["show", "HEAD:.lightwell/notes.json"])).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn selected_note_commit_preserves_other_notes_and_unrelated_staging() {
        let f = Fixture::new(true);
        f.save("first", "first original");
        f.save("second", "second original");
        fs::write(f.root.join("staged.txt"), "original\n").unwrap();
        fs::write(f.root.join("unstaged.txt"), "original\n").unwrap();
        f.git(&["add", ".lightwell/notes.json", "staged.txt", "unstaged.txt"]);
        f.git(&["commit", "-qm", "Initial"]);
        f.save("second", "second staged");
        f.git(&["add", ".lightwell/notes.json"]);
        f.save("second", "second working");
        f.save("first", "first selected");
        fs::write(f.root.join("staged.txt"), "staged change\n").unwrap();
        f.git(&["add", "staged.txt"]);
        fs::write(f.root.join("staged.txt"), "working change\n").unwrap();
        fs::write(f.root.join("unstaged.txt"), "unstaged change\n").unwrap();
        fs::write(f.root.join("untracked.txt"), "untracked\n").unwrap();
        let working_notes = fs::read(ProjectNotesStore::new(&f.root).path).unwrap();
        let result = f.commit("first", "first selected").unwrap();
        assert!(result.commit_id.is_some());
        assert!(matches!(
            result.status,
            NotesGitStatus::Ready {
                note_changed: false,
                ..
            }
        ));
        let head = f.head_notes();
        assert_eq!(head.notes["first"].text, "first selected");
        assert_eq!(head.notes["second"].text, "second original");
        let staged: NotesDocument =
            serde_json::from_str(&f.git(&["show", ":.lightwell/notes.json"])).unwrap();
        assert_eq!(staged.notes["first"].text, "first selected");
        assert_eq!(staged.notes["second"].text, "second staged");
        assert_eq!(
            fs::read(ProjectNotesStore::new(&f.root).path).unwrap(),
            working_notes
        );
        assert_eq!(f.git(&["show", "HEAD:staged.txt"]), "original\n");
        assert_eq!(f.git(&["show", ":staged.txt"]), "staged change\n");
        assert_eq!(
            fs::read_to_string(f.root.join("staged.txt")).unwrap(),
            "working change\n"
        );
        assert_eq!(
            fs::read_to_string(f.root.join("unstaged.txt")).unwrap(),
            "unstaged change\n"
        );
        assert_eq!(
            f.git(&["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
            ".lightwell/notes.json\n"
        );
        let head_id = f.git(&["rev-parse", "HEAD"]);
        assert!(f
            .commit("first", "first selected")
            .unwrap()
            .commit_id
            .is_none());
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head_id);
    }

    #[test]
    fn unborn_repository_commits_only_selected_note() {
        let f = Fixture::new(true);
        f.save("first", "selected");
        f.save("second", "private draft");
        fs::write(f.root.join("unrelated"), "staged\n").unwrap();
        f.git(&["add", "unrelated"]);
        assert!(matches!(
            project_note_git_status(&f.root, "first"),
            NotesGitStatus::Ready {
                state: NotesGitFileState::Untracked,
                note_changed: true,
                ..
            }
        ));
        f.commit("first", "selected").unwrap();
        let head = f.head_notes();
        assert_eq!(head.notes.len(), 1);
        assert_eq!(head.notes["first"].text, "selected");
        assert_eq!(f.git(&["ls-tree", "--name-only", "HEAD"]), ".lightwell\n");
        assert_eq!(f.git(&["show", ":unrelated"]), "staged\n");
    }

    #[test]
    fn status_is_read_only_and_explains_non_git_missing_and_ignored() {
        let f = Fixture::new(false);
        assert!(matches!(
            project_note_git_status(&f.root, "first"),
            NotesGitStatus::NotRepository
        ));
        assert!(!f.root.join(".lightwell").exists());
        f.git(&["init", "-q"]);
        assert!(matches!(
            project_note_git_status(&f.root, "first"),
            NotesGitStatus::Missing
        ));
        assert!(!f.root.join(".lightwell").exists());
        f.save("first", "saved");
        fs::remove_file(f.root.join(".lightwell/notes.lock")).unwrap();
        fs::write(f.root.join(".gitignore"), ".lightwell/\n").unwrap();
        assert!(matches!(
            project_note_git_status(&f.root, "first"),
            NotesGitStatus::Ignored
        ));
        assert!(!f.root.join(".lightwell/notes.lock").exists());
        assert!(f.commit("first", "saved").unwrap_err().contains("ignored"));
        assert_eq!(
            fs::read_to_string(f.root.join(".gitignore")).unwrap(),
            ".lightwell/\n"
        );
    }

    #[test]
    fn stale_and_failed_actions_leave_saved_notes_and_index_intact() {
        let f = Fixture::new(true);
        f.save("first", "saved");
        let old_revision = revision(&ProjectNotesStore::new(&f.root).path).unwrap();
        f.save("first", "updated");
        assert!(
            commit_project_note(&f.root, "first", &old_revision, "saved", "fingerprint")
                .unwrap_err()
                .contains("changed")
        );
        fs::write(f.root.join("unrelated"), "staged\n").unwrap();
        f.git(&["add", "unrelated"]);
        let before = fs::read(f.root.join(".git/index")).unwrap();
        let notes = fs::read(ProjectNotesStore::new(&f.root).path).unwrap();
        f.git(&["config", "commit.gpgsign", "true"]);
        f.git(&["config", "gpg.format", "openpgp"]);
        f.git(&["config", "gpg.program", "lightwell-missing-signing-program"]);
        assert!(f
            .commit("first", "updated")
            .unwrap_err()
            .contains("could not commit"));
        assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), before);
        assert_eq!(
            fs::read(ProjectNotesStore::new(&f.root).path).unwrap(),
            notes
        );
        assert!(!f.root.join(".git/index.lock").exists());
        f.git(&["config", "commit.gpgsign", "false"]);
        assert!(f.commit("first", "updated").unwrap().commit_id.is_some());
        assert_eq!(f.head_notes().notes["first"].text, "updated");
    }

    #[test]
    fn nested_project_uses_its_own_authoritative_notes_path() {
        let f = Fixture::new(true);
        let nested = f.root.join("nested");
        fs::create_dir(&nested).unwrap();
        ProjectNotesStore::new(&nested)
            .set("first", "nested note", "fingerprint")
            .unwrap();
        let revision = revision(&ProjectNotesStore::new(&nested).path).unwrap();
        commit_project_note(&nested, "first", &revision, "nested note", "fingerprint").unwrap();
        let document: NotesDocument =
            serde_json::from_str(&f.git(&["show", "HEAD:nested/.lightwell/notes.json"])).unwrap();
        assert_eq!(document.notes["first"].text, "nested note");
        assert!(!f.root.join(".lightwell").exists());
    }
    #[test]
    fn busy_index_is_retained_and_retry_succeeds() {
        let f = Fixture::new(true);
        f.save("first", "saved");
        fs::write(f.root.join(".git/index.lock"), "another Git operation").unwrap();
        assert!(f
            .commit("first", "saved")
            .unwrap_err()
            .contains("Cannot lock"));
        assert_eq!(
            fs::read_to_string(f.root.join(".git/index.lock")).unwrap(),
            "another Git operation"
        );
        fs::remove_file(f.root.join(".git/index.lock")).unwrap();
        f.commit("first", "saved").unwrap();
        assert_eq!(f.head_notes().notes["first"].text, "saved");
    }

    #[test]
    fn conflicted_notes_are_not_committed_or_rewritten() {
        let f = Fixture::new(true);
        f.save("first", "base");
        f.git(&["add", ".lightwell/notes.json"]);
        f.git(&["commit", "-qm", "Base"]);
        f.git(&["checkout", "-qb", "other"]);
        f.save("first", "other");
        f.git(&["commit", "-qam", "Other"]);
        f.git(&["checkout", "-q", "-"]);
        f.save("first", "current");
        f.git(&["commit", "-qam", "Current"]);
        let output = Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args(["merge", "other"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(matches!(
            project_note_git_status(&f.root, "first"),
            NotesGitStatus::Conflicted
        ));
        let before = fs::read(f.root.join(".lightwell/notes.json")).unwrap();
        assert!(f.commit("first", "current").is_err());
        assert_eq!(
            fs::read(f.root.join(".lightwell/notes.json")).unwrap(),
            before
        );
        assert!(f
            .git(&["ls-files", "--unmerged"])
            .contains(".lightwell/notes.json"));
    }

    #[test]
    fn linked_worktree_uses_its_own_index_and_head() {
        let f = Fixture::new(true);
        f.save("first", "base");
        f.git(&["add", ".lightwell/notes.json"]);
        f.git(&["commit", "-qm", "Base"]);
        let original_head = f.git(&["rev-parse", "HEAD"]);
        let linked = f.root.join("linked");
        f.git(&[
            "worktree",
            "add",
            "-qb",
            "linked-notes",
            linked.to_str().unwrap(),
        ]);
        ProjectNotesStore::new(&linked)
            .set("first", "linked update", "fingerprint")
            .unwrap();
        let token = revision(&ProjectNotesStore::new(&linked).path).unwrap();
        commit_project_note(&linked, "first", &token, "linked update", "fingerprint").unwrap();
        assert_eq!(f.git(&["rev-parse", "HEAD"]), original_head);
        let output = Command::new("git")
            .arg("-C")
            .arg(&linked)
            .args(["show", "HEAD:.lightwell/notes.json"])
            .output()
            .unwrap();
        let document: NotesDocument = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(document.notes["first"].text, "linked update");
        assert!(!f.root.join(".git/worktrees/linked/index.lock").exists());
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_storage_is_rejected_before_lock_creation() {
        let f = Fixture::new(true);
        let outside = Fixture::new(false);
        std::os::unix::fs::symlink(&outside.root, f.root.join(".lightwell")).unwrap();
        assert!(matches!(
            project_note_git_status(&f.root, "first"),
            NotesGitStatus::Unavailable { .. }
        ));
        assert!(
            commit_project_note(&f.root, "first", "old", "text", "fingerprint")
                .unwrap_err()
                .contains("symlink")
        );
        assert!(!outside.root.join("notes.lock").exists());
    }
}
