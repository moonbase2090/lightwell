use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

const BLOCK: &str = "module:notes-contracts:crate root";
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "lightwell-cli-notes-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"notes-contracts\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn before() -> u8 { 1 }\n").unwrap();
        Self(root)
    }

    fn run(&self, arguments: &[&str], exit: i32) -> Output {
        self.run_in(&self.0, arguments, exit)
    }

    fn run_in(&self, cwd: &std::path::Path, arguments: &[&str], exit: i32) -> Output {
        let enable_stale = arguments
            .iter()
            .any(|argument| *argument == "review" || *argument == "rm-stale");
        let mut command = Command::new(env!("CARGO_BIN_EXE_lightwell"));
        command.current_dir(cwd).args(arguments);
        if enable_stale {
            command.env("LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS", "true");
        } else {
            command.env_remove("LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS");
        }
        let output = command.output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit),
            "cwd: {}\narguments: {arguments:?}\nstdout: {}\nstderr: {}",
            cwd.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn json(&self, arguments: &[&str]) -> Value {
        let output = self.run(arguments, 0);
        assert!(output.stderr.is_empty(), "{:?}", output.stderr);
        assert!(output.stdout.ends_with(b"\n"));
        serde_json::from_slice(&output.stdout).expect("stdout must contain exactly one JSON value")
    }

    fn json_in(&self, cwd: &std::path::Path, arguments: &[&str]) -> Value {
        let output = self.run_in(cwd, arguments, 0);
        assert!(output.stderr.is_empty(), "{:?}", output.stderr);
        assert!(output.stdout.ends_with(b"\n"));
        serde_json::from_slice(&output.stdout).expect("stdout must contain exactly one JSON value")
    }

    fn error(&self, arguments: &[&str], exit: i32, diagnostic: &str) {
        let output = self.run(arguments, exit);
        assert!(output.stdout.is_empty(), "{:?}", output.stdout);
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(diagnostic),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn json_notes_roundtrip_reports_persisted_text_and_removal() {
    let project = Project::new();
    assert_eq!(project.json(&["notes", "list", "--json"]), json!([]));
    assert!(!project.0.join(".lightwell").exists());

    let text = "A \"quoted\" note\nSecond line: λ";
    let set = project.json(&["notes", "set", "--json", BLOCK, text]);
    assert_eq!(set["blockId"], BLOCK);
    assert_eq!(set["text"], text);
    assert_eq!(set["author"], "unknown");
    let set_updated = set["updatedAt"]
        .as_str()
        .expect("set JSON includes updatedAt");
    assert!(
        set_updated.ends_with('Z') && set_updated.len() == 20,
        "updatedAt should be RFC3339 UTC with seconds: {set_updated}"
    );
    let notes = project.json(&["notes", "list", "--json"]);
    assert_eq!(notes.as_array().unwrap().len(), 1);
    assert_eq!(notes[0]["blockId"], BLOCK);
    assert_eq!(notes[0]["text"], text);
    assert_eq!(notes[0]["stale"], false);
    assert_eq!(notes[0]["author"], "unknown");
    assert_eq!(notes[0]["updatedAt"], set_updated);
    let fingerprint = notes[0]["sourceFingerprint"].as_str().unwrap();
    assert_eq!(fingerprint.len(), 64);
    assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let saved: Value =
        serde_json::from_slice(&fs::read(project.0.join(".lightwell/notes.json")).unwrap())
            .unwrap();
    assert_eq!(saved["notes"][BLOCK]["text"], text);
    assert_eq!(saved["notes"][BLOCK]["sourceFingerprint"], fingerprint);
    assert_eq!(saved["notes"][BLOCK]["author"], "unknown");
    assert_eq!(saved["notes"][BLOCK]["updatedAt"], set_updated);

    assert_eq!(
        project.json(&["notes", "rm", BLOCK, "--json"]),
        json!({"blockId": BLOCK, "removed": true})
    );
    assert_eq!(project.json(&["notes", "list", "--json"]), json!([]));
    project.error(&["notes", "rm", BLOCK, "--json"], 3, "No saved note");
}

#[test]
fn legacy_note_without_updated_at_lists_unknown_timestamp() {
    let project = Project::new();
    project.json(&["notes", "set", "--json", BLOCK, "Legacy note"]);
    let notes_path = project.0.join(".lightwell/notes.json");
    let mut document: Value = serde_json::from_slice(&fs::read(&notes_path).unwrap()).unwrap();
    let note = document["notes"][BLOCK].as_object_mut().unwrap();
    note.remove("author");
    note.remove("updatedAt");
    fs::write(&notes_path, serde_json::to_vec(&document).unwrap()).unwrap();

    let listed = String::from_utf8(project.run(&["notes", "list"], 0).stdout).unwrap();
    assert!(listed.contains("; author unknown; updated unknown): Legacy note"));
    assert!(!listed.contains("updated )"));
}

#[test]
fn human_success_output_remains_unchanged() {
    let project = Project::new();
    assert_eq!(
        project.run(&["notes", "list"], 0).stdout,
        b"No project notes. Save one with `lightwell notes set <block-id> <text...>`.\n"
    );
    let saved = project.run(&["notes", "set", BLOCK, "Keep this note"], 0);
    assert_eq!(
        String::from_utf8(saved.stdout).unwrap(),
        format!("Saved note for `{BLOCK}` in `.lightwell/notes.json`.\n")
    );
    assert!(saved.stderr.is_empty());
    let listed = project.run(&["notes", "list"], 0);
    let text = String::from_utf8(listed.stdout).unwrap();
    assert!(text.starts_with(&format!("[current] {BLOCK} (source fingerprint ")));
    assert!(text.contains("; author unknown; updated "));
    assert!(text.ends_with("): Keep this note\n"));
    let removed = project.run(&["notes", "rm", BLOCK], 0);
    assert_eq!(
        String::from_utf8(removed.stdout).unwrap(),
        format!("Removed note for `{BLOCK}`.\n")
    );
    assert!(removed.stderr.is_empty());
}

#[test]
fn replacing_a_note_requires_an_explicit_flag_and_is_noninteractive() {
    let project = Project::new();
    project.json(&["notes", "set", "--json", BLOCK, "Keep the existing note"]);
    let notes_path = project.0.join(".lightwell/notes.json");
    let saved_before = fs::read(&notes_path).unwrap();

    let rejected = project.run(
        &["notes", "set", "--json", BLOCK, "Accidental replacement"],
        6,
    );
    assert!(rejected.stdout.is_empty());
    let diagnostic = String::from_utf8_lossy(&rejected.stderr);
    assert!(diagnostic.contains(&format!("A note already exists for block `{BLOCK}`")));
    assert!(diagnostic.contains("--replace"));
    assert_eq!(fs::read(&notes_path).unwrap(), saved_before);

    let replaced = project.json(&[
        "notes",
        "set",
        "--json",
        "--replace",
        BLOCK,
        "Intentional replacement",
    ]);
    assert_eq!(replaced["blockId"], BLOCK);
    assert_eq!(replaced["text"], "Intentional replacement");
    assert_eq!(replaced["author"], "unknown");
    assert!(!replaced["updatedAt"].as_str().unwrap().is_empty());
    assert_eq!(
        project.json(&["notes", "list", "--json"])[0]["text"],
        "Intentional replacement"
    );
    project.error(&["notes", "list", "--replace"], 2, "only available");
}

#[test]
fn missing_saved_note_and_current_block_have_distinct_exits() {
    let project = Project::new();
    for json_flag in [false, true] {
        let mut remove = vec!["notes", "rm", BLOCK];
        let mut set = vec!["notes", "set", "module:missing", "Keep this note"];
        if json_flag {
            remove.push("--json");
            set.push("--json");
        }
        project.error(&remove, 3, "No saved note");
        project.error(&set, 4, "No block with ID `module:missing`");
    }
    assert!(!project.0.join(".lightwell/notes.json").exists());
}

#[test]
fn check_reports_changed_source_without_mutating_or_suppressing_notes() {
    let project = Project::new();
    assert_eq!(
        project.json(&["notes", "list", "--check", "--json"]),
        json!([])
    );
    project.json(&["notes", "set", BLOCK, "Review this source", "--json"]);
    let current = project.json(&["notes", "list", "--json", "--check"]);
    assert_eq!(current[0]["stale"], false);
    let saved = fs::read(project.0.join(".lightwell/notes.json")).unwrap();

    fs::write(
        project.0.join("src/lib.rs"),
        "pub fn before() -> u8 { 1 }\npub fn after() -> u8 { 2 }\n",
    )
    .unwrap();
    let unchecked = project.json(&["notes", "list", "--json"]);
    assert_eq!(unchecked[0]["stale"], true);
    assert_eq!(unchecked[0]["text"], "Review this source");
    let checked = project.run(&["notes", "list", "--check", "--json"], 5);
    assert_eq!(
        serde_json::from_slice::<Value>(&checked.stdout).unwrap(),
        unchecked
    );
    assert!(String::from_utf8_lossy(&checked.stderr).contains("1 stale project note"));
    let human = project.run(&["notes", "list", "--check"], 5);
    assert!(String::from_utf8_lossy(&human.stdout).starts_with(&format!("[stale] {BLOCK} ")));
    assert!(String::from_utf8_lossy(&human.stderr).contains("1 stale project note"));
    assert_eq!(
        fs::read(project.0.join(".lightwell/notes.json")).unwrap(),
        saved
    );
}

#[test]
fn review_re_fingerprints_a_stale_note_and_rm_stale_requires_yes() {
    let project = Project::new();
    project.json(&["notes", "set", BLOCK, "Still accurate", "--json"]);
    let old_fingerprint = project.json(&["notes", "list", "--json"])[0]["sourceFingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::write(
        project.0.join("src/lib.rs"),
        "pub fn before() -> u8 { 1 }\npub fn after() -> u8 { 2 }\n",
    )
    .unwrap();
    assert_eq!(project.json(&["notes", "list", "--json"])[0]["stale"], true);

    project.error(
        &["notes", "rm-stale", "--json"],
        2,
        "requires `--yes` to delete stale notes",
    );
    let gated = Command::new(env!("CARGO_BIN_EXE_lightwell"))
        .current_dir(&project.0)
        .args(["notes", "review", BLOCK, "--json"])
        .env_remove("LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS")
        .output()
        .unwrap();
    assert_eq!(gated.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&gated.stderr)
            .contains("LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS=true"),
        "{}",
        String::from_utf8_lossy(&gated.stderr)
    );
    assert_eq!(project.json(&["notes", "list", "--json"])[0]["stale"], true);

    let reviewed = project.json(&["notes", "review", BLOCK, "--json"]);
    assert_eq!(reviewed["blockId"], BLOCK);
    assert_eq!(reviewed["reviewed"], true);
    assert_eq!(reviewed["stale"], false);
    assert_ne!(reviewed["sourceFingerprint"], old_fingerprint);
    assert_eq!(
        project.json(&["notes", "list", "--json"])[0]["stale"],
        false
    );

    let notes_path = project.0.join(".lightwell/notes.json");
    let mut document: Value = serde_json::from_slice(&fs::read(&notes_path).unwrap()).unwrap();
    document["notes"]["crate:gone"] = json!({
        "text": "orphan",
        "sourceFingerprint": "deadbeef"
    });
    fs::write(
        &notes_path,
        format!("{}\n", serde_json::to_string_pretty(&document).unwrap()),
    )
    .unwrap();
    let listed = project.json(&["notes", "list", "--json"]);
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .filter(|note| note["stale"] == true)
            .count(),
        1
    );

    let removed = project.json(&["notes", "rm-stale", "--yes", "--json"]);
    assert_eq!(removed["removed"], 1);
    let remaining = removed["notes"].as_array().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["blockId"], BLOCK);
    assert_eq!(remaining[0]["stale"], false);
    assert_eq!(remaining[0]["text"], "Still accurate");
}

#[test]
fn orphaned_saved_notes_are_stale_but_can_still_be_removed() {
    let project = Project::new();
    fs::write(project.0.join("src/lib.rs"), "pub mod extra;\n").unwrap();
    fs::write(project.0.join("src/extra.rs"), "pub fn extra() {}\n").unwrap();
    let block = "module:notes-contracts:crate root::extra";
    project.json(&["notes", "set", block, "Keep orphaned note", "--json"]);
    fs::remove_file(project.0.join("src/extra.rs")).unwrap();
    fs::write(project.0.join("src/lib.rs"), "pub fn replacement() {}\n").unwrap();
    let checked = project.run(&["notes", "list", "--check", "--json"], 5);
    let notes: Value = serde_json::from_slice(&checked.stdout).unwrap();
    assert_eq!(notes[0]["blockId"], block);
    assert_eq!(notes[0]["stale"], true);
    assert_eq!(notes[0]["text"], "Keep orphaned note");
    assert_eq!(
        project.json(&["notes", "rm", block, "--json"]),
        json!({"blockId": block, "removed": true})
    );
    assert_eq!(
        project.json(&["notes", "list", "--json", "--check"]),
        json!([])
    );
}

#[test]
fn option_terminator_preserves_literal_flag_text_and_invalid_usage_does_not_write() {
    let project = Project::new();
    let repo = project.0.to_string_lossy().into_owned();
    for arguments in [
        vec!["notes", "list", "--json", "--json"],
        vec!["notes", "list", "--check", "--check"],
        vec!["notes", "list", "--unknown"],
        vec!["notes", "list", "unexpected"],
        vec!["notes", "rm", BLOCK, "--check"],
        vec!["notes", "rm", BLOCK, "extra", "--json"],
        vec!["notes", "rm-stale"],
        vec!["notes", "rm-stale", "--yes", "extra"],
        vec!["notes", "review"],
        vec!["notes", "set", BLOCK, "text", "--check"],
        vec!["notes", "set", BLOCK, "--json"],
        vec!["notes", "list", "-C"],
        vec!["notes", "list", "--repo"],
        vec!["notes", "-C"],
        vec!["notes", "list", "-C", repo.as_str(), "-C", repo.as_str()],
        vec![
            "notes",
            "list",
            "--repo",
            repo.as_str(),
            "-C",
            repo.as_str(),
        ],
    ] {
        project.error(&arguments, 2, "lightwell:");
        assert!(!project.0.join(".lightwell/notes.json").exists());
    }
    let set = project.json(&["notes", "set", "--json", BLOCK, "--", "--json", "--check"]);
    assert_eq!(set["blockId"], BLOCK);
    assert_eq!(set["text"], "--json --check");
    assert!(set.get("author").and_then(Value::as_str).is_some());
    assert!(set.get("updatedAt").and_then(Value::as_str).is_some());
    assert_eq!(
        project.json(&["notes", "list", "--json"])[0]["text"],
        "--json --check"
    );
}

#[test]
fn repo_flag_targets_another_workspace_from_a_foreign_cwd() {
    let project = Project::new();
    let text = "Note saved through -C";
    project.json(&["notes", "set", "--json", BLOCK, text]);

    let foreign = std::env::temp_dir().join(format!(
        "lightwell-cli-notes-foreign-{}-{}",
        std::process::id(),
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&foreign).unwrap();
    let _cleanup = ForeignDir(foreign.clone());
    let repo = project.0.to_string_lossy();

    assert_eq!(
        project.json_in(&foreign, &["notes", "list", "-C", repo.as_ref(), "--json"],)[0]["text"],
        text
    );
    assert_eq!(
        project.json_in(
            &foreign,
            &["notes", "--repo", repo.as_ref(), "list", "--json"],
        )[0]["text"],
        text
    );

    let updated = "Updated from foreign cwd";
    let updated_note = &project.json_in(
        &foreign,
        &[
            "notes",
            "set",
            "--repo",
            repo.as_ref(),
            "--json",
            "--replace",
            BLOCK,
            updated,
        ],
    );
    assert_eq!(updated_note["blockId"], BLOCK);
    assert_eq!(updated_note["text"], updated);
    assert_eq!(updated_note["author"], "unknown");
    let stored: Value =
        serde_json::from_slice(&fs::read(project.0.join(".lightwell/notes.json")).unwrap())
            .unwrap();
    assert_eq!(
        stored["notes"][BLOCK]["updatedAt"],
        updated_note["updatedAt"]
    );
    assert!(updated_note["updatedAt"].as_str().unwrap().ends_with('Z'));
    assert!(!foreign.join(".lightwell").exists());
    assert_eq!(
        project.json(&["notes", "list", "--json"])[0]["text"],
        updated
    );

    assert_eq!(
        project.json_in(
            &foreign,
            &["notes", "rm", BLOCK, "-C", repo.as_ref(), "--json"],
        ),
        json!({"blockId": BLOCK, "removed": true})
    );
    assert_eq!(project.json(&["notes", "list", "--json"]), json!([]));
}

struct ForeignDir(PathBuf);

impl Drop for ForeignDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn corrupt_storage_reports_errors_on_stderr_without_success_json() {
    let project = Project::new();
    assert_eq!(project.json(&["notes", "list", "--json"]), json!([]));
    fs::create_dir(project.0.join(".lightwell")).unwrap();
    fs::write(project.0.join(".lightwell/notes.json"), "{broken").unwrap();
    for arguments in [
        vec!["notes", "list", "--json"],
        vec!["notes", "set", BLOCK, "Keep this note", "--json"],
        vec!["notes", "rm", BLOCK, "--json"],
    ] {
        project.error(&arguments, 1, "Could not parse project notes");
        assert_eq!(
            fs::read_to_string(project.0.join(".lightwell/notes.json")).unwrap(),
            "{broken"
        );
    }
}

fn git(root: &std::path::Path, args: &[&str]) -> Output {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "user.name=Lightwell Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn notes_set_leaves_notes_unstaged_so_documented_git_add_is_required() {
    let project = Project::new();
    git(&project.0, &["init", "-q"]);
    git(&project.0, &["add", "Cargo.toml", "src"]);
    git(&project.0, &["commit", "-q", "-m", "Initial"]);
    project.json(&["notes", "set", "--json", BLOCK, "Agent note"]);

    let before =
        String::from_utf8(git(&project.0, &["status", "--porcelain", "-uall"]).stdout).unwrap();
    assert!(
        before
            .lines()
            .any(|line| line == "?? .lightwell/notes.json"),
        "notes set must leave notes.json untracked so agents still need git add: {before:?}"
    );
    assert!(
        !before.lines().any(|line| {
            let staged = line.as_bytes().first().copied().unwrap_or(b' ');
            staged != b'?' && staged != b' ' && line.contains(".lightwell/notes.json")
        }),
        "notes set must not stage notes.json: {before:?}"
    );

    git(&project.0, &["add", ".lightwell/notes.json"]);
    let after =
        String::from_utf8(git(&project.0, &["status", "--porcelain", "-uall"]).stdout).unwrap();
    assert!(
        after.lines().any(|line| line == "A  .lightwell/notes.json"),
        "documented `git add .lightwell/notes.json` must stage the saved notes file: {after:?}"
    );
}

#[test]
fn for_file_returns_only_notes_for_matching_source_and_marks_stale_notes() {
    let project = Project::new();
    fs::write(
        project.0.join("src/lib.rs"),
        "pub mod extra;\npub fn before() -> u8 { 1 }\n",
    )
    .unwrap();
    fs::write(
        project.0.join("src/extra.rs"),
        "pub fn extra() -> u8 { 2 }\n",
    )
    .unwrap();
    let extra = "module:notes-contracts:crate root::extra";
    project.json(&["notes", "set", BLOCK, "Root note", "--json"]);
    project.json(&["notes", "set", extra, "Extra note", "--json"]);

    let root_notes = project.json(&["notes", "for-file", "src/lib.rs", "--json"]);
    assert_eq!(root_notes.as_array().unwrap().len(), 1);
    assert_eq!(root_notes[0]["blockId"], BLOCK);
    assert_eq!(root_notes[0]["text"], "Root note");
    assert_eq!(root_notes[0]["stale"], false);

    let extra_notes = project.json(&["notes", "for-file", "src/extra.rs", "--json"]);
    assert_eq!(extra_notes.as_array().unwrap().len(), 1);
    assert_eq!(extra_notes[0]["blockId"], extra);
    assert_eq!(extra_notes[0]["text"], "Extra note");

    fs::write(
        project.0.join("src/extra.rs"),
        "pub fn extra() -> u8 { 3 }\n",
    )
    .unwrap();
    let stale = project.json(&["notes", "for-file", "src/extra.rs", "--json"]);
    assert_eq!(stale[0]["blockId"], extra);
    assert_eq!(stale[0]["text"], "Extra note");
    assert_eq!(stale[0]["stale"], true);

    assert_eq!(
        project.json(&["notes", "for-file", "src/missing.rs", "--json"]),
        json!([])
    );
    assert_eq!(
        project
            .run(&["notes", "for-file", "src/missing.rs"], 0)
            .stdout,
        b"No project notes for file `src/missing.rs`.\n"
    );
}
