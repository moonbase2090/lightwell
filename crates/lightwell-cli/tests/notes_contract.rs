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
        let output = Command::new(env!("CARGO_BIN_EXE_lightwell"))
            .current_dir(&self.0)
            .args(arguments)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit),
            "arguments: {arguments:?}\nstdout: {}\nstderr: {}",
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
    assert_eq!(
        project.json(&["notes", "set", "--json", BLOCK, text]),
        json!({"blockId": BLOCK, "text": text})
    );
    let notes = project.json(&["notes", "list", "--json"]);
    assert_eq!(notes.as_array().unwrap().len(), 1);
    assert_eq!(notes[0]["blockId"], BLOCK);
    assert_eq!(notes[0]["text"], text);
    assert_eq!(notes[0]["stale"], false);
    let fingerprint = notes[0]["sourceFingerprint"].as_str().unwrap();
    assert_eq!(fingerprint.len(), 64);
    assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let saved: Value =
        serde_json::from_slice(&fs::read(project.0.join(".lightwell/notes.json")).unwrap())
            .unwrap();
    assert_eq!(saved["notes"][BLOCK]["text"], text);
    assert_eq!(saved["notes"][BLOCK]["sourceFingerprint"], fingerprint);

    assert_eq!(
        project.json(&["notes", "rm", BLOCK, "--json"]),
        json!({"blockId": BLOCK, "removed": true})
    );
    assert_eq!(project.json(&["notes", "list", "--json"]), json!([]));
    project.error(&["notes", "rm", BLOCK, "--json"], 3, "No saved note");
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
    assert!(text.ends_with("): Keep this note\n"));
    let removed = project.run(&["notes", "rm", BLOCK], 0);
    assert_eq!(
        String::from_utf8(removed.stdout).unwrap(),
        format!("Removed note for `{BLOCK}`.\n")
    );
    assert!(removed.stderr.is_empty());
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
    for arguments in [
        vec!["notes", "list", "--json", "--json"],
        vec!["notes", "list", "--check", "--check"],
        vec!["notes", "list", "--unknown"],
        vec!["notes", "list", "unexpected"],
        vec!["notes", "rm", BLOCK, "--check"],
        vec!["notes", "rm", BLOCK, "extra", "--json"],
        vec!["notes", "set", BLOCK, "text", "--check"],
        vec!["notes", "set", BLOCK, "--json"],
    ] {
        project.error(&arguments, 2, "lightwell:");
        assert!(!project.0.join(".lightwell/notes.json").exists());
    }
    assert_eq!(
        project.json(&["notes", "set", "--json", BLOCK, "--", "--json", "--check"]),
        json!({"blockId": BLOCK, "text": "--json --check"})
    );
    assert_eq!(
        project.json(&["notes", "list", "--json"])[0]["text"],
        "--json --check"
    );
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
    project.json(&["notes", "set", "--json", BLOCK, "Agent note"]);

    let before = String::from_utf8(git(&project.0, &["status", "--porcelain"]).stdout).unwrap();
    assert!(
        before
            .lines()
            .any(|line| line == "?? .lightwell/notes.json"),
        "notes set must leave notes.json untracked so agents still need git add: {before:?}"
    );
    assert!(
        !before
            .lines()
            .any(|line| { line.starts_with('A') && line.contains(".lightwell/notes.json") }),
        "notes set must not stage notes.json: {before:?}"
    );

    git(&project.0, &["add", ".lightwell/notes.json"]);
    let after = String::from_utf8(git(&project.0, &["status", "--porcelain"]).stdout).unwrap();
    assert!(
        after.lines().any(|line| line == "A  .lightwell/notes.json"),
        "documented `git add .lightwell/notes.json` must stage the saved notes file: {after:?}"
    );
}
