use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
static NEXT_TRACE: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "lightwell-cli-map-reuse-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"map-reuse\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn before() -> u8 { 1 }\n").unwrap();
        Self(root)
    }

    fn notes_file(&self) -> PathBuf {
        self.0.join(".lightwell/notes.json")
    }

    fn run_traced(&self, arguments: &[&str], exit: i32) -> (Output, usize) {
        let trace = self.0.join(format!(
            "extract-trace-{}",
            NEXT_TRACE.fetch_add(1, Ordering::Relaxed)
        ));
        let output = Command::new(env!("CARGO_BIN_EXE_lightwell"))
            .current_dir(&self.0)
            .env("LIGHTWELL_EXTRACT_TRACE", &trace)
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
        let extracts = fs::read_to_string(&trace)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("extract "))
            .count();
        (output, extracts)
    }

    fn extract(&self, file_name: &str) -> (Value, usize) {
        let output_path = self.0.join(file_name);
        let root = self.0.to_string_lossy().into_owned();
        let destination = output_path.to_string_lossy().into_owned();
        let (output, extracts) = self.run_traced(&["extract", &root, "-o", &destination], 0);
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("Wrote "));
        let facts = serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
        (facts, extracts)
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn block_for_source(facts: &Value, source: &str) -> (String, String) {
    let matches = facts["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|block| block["sourcePath"].as_str() == Some(source))
        .collect::<Vec<_>>();
    assert_eq!(
        matches.len(),
        1,
        "expected one block for {source} in {}",
        serde_json::to_string(facts).unwrap()
    );
    let id = matches[0]["id"].as_str().unwrap().to_owned();
    let fingerprint = matches[0]["fingerprint"].as_str().unwrap().to_owned();
    assert_eq!(fingerprint.len(), 64, "{fingerprint}");
    assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
    (id, fingerprint)
}

fn saved_note(project: &Project, block_id: &str) -> Value {
    let document: Value = serde_json::from_slice(&fs::read(project.notes_file()).unwrap()).unwrap();
    document["notes"][block_id].clone()
}

fn listed_note(stdout: &[u8]) -> Value {
    let notes: Value = serde_json::from_slice(stdout).unwrap();
    assert_eq!(notes.as_array().unwrap().len(), 1);
    notes[0].clone()
}

#[test]
fn separate_notes_list_processes_each_extract_once() {
    let project = Project::new();
    let (first, first_extracts) = project.run_traced(&["notes", "list"], 0);
    let (second, second_extracts) = project.run_traced(&["notes", "list"], 0);
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(
        first.stdout,
        b"No project notes. Save one with `lightwell notes set <block-id> <text...>`.\n"
    );
    assert_eq!(first_extracts, 1);
    assert_eq!(second_extracts, 1);
}

#[test]
fn file_set_and_unknown_id_extract_once() {
    let project = Project::new();
    let (facts, extract_count) = project.extract("facts.json");
    assert_eq!(extract_count, 1);
    let (block_id, fingerprint) = block_for_source(&facts, "src/lib.rs");

    let (set, set_extracts) = project.run_traced(
        &[
            "notes",
            "set",
            "--file",
            "src/lib.rs",
            "--json",
            "File note",
        ],
        0,
    );
    assert_eq!(set_extracts, 1);
    let result: Value = serde_json::from_slice(&set.stdout).unwrap();
    assert_eq!(result["blockId"], block_id);
    assert_eq!(result["text"], "File note");
    assert_eq!(result["author"], "unknown");
    assert!(result["updatedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        saved_note(&project, &block_id)["updatedAt"],
        result["updatedAt"]
    );
    assert_eq!(
        saved_note(&project, &block_id)["sourceFingerprint"],
        fingerprint
    );
    assert_eq!(saved_note(&project, &block_id)["text"], "File note");
    let persisted = fs::read(project.notes_file()).unwrap();

    let (miss, miss_extracts) = project.run_traced(&["notes", "set", "map-reuse", "nope"], 4);
    assert_eq!(miss_extracts, 1);
    assert!(miss.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&miss.stderr).contains(&format!("Did you mean `{block_id}`?")),
        "{}",
        String::from_utf8_lossy(&miss.stderr)
    );
    assert_eq!(fs::read(project.notes_file()).unwrap(), persisted);
}

#[test]
fn reused_map_skips_extract_and_stale_checks_follow_that_map() {
    let project = Project::new();
    let (before, before_extracts) = project.extract("before.facts.json");
    assert_eq!(before_extracts, 1);
    let (block_id, fingerprint_before) = block_for_source(&before, "src/lib.rs");
    let before_path = project.0.join("before.facts.json");
    let before_arg = before_path.to_string_lossy().into_owned();

    let (set, set_extracts) =
        project.run_traced(&["notes", "set", "--json", &block_id, "Keep this note"], 0);
    assert_eq!(set_extracts, 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&set.stdout).unwrap()["blockId"],
        block_id
    );
    assert_eq!(
        saved_note(&project, &block_id)["sourceFingerprint"],
        fingerprint_before
    );

    let (listed, listed_extracts) =
        project.run_traced(&["notes", "list", "--json", "--map", &before_arg], 0);
    assert_eq!(listed_extracts, 0);
    let note = listed_note(&listed.stdout);
    assert_eq!(note["blockId"], block_id);
    assert_eq!(note["text"], "Keep this note");
    assert_eq!(note["stale"], false);
    assert_eq!(note["sourceFingerprint"], fingerprint_before);

    let (by_file, by_file_extracts) = project.run_traced(
        &[
            "notes",
            "set",
            "--file",
            "src/lib.rs",
            "--replace",
            "--map",
            &before_arg,
            "--json",
            "From the facts file",
        ],
        0,
    );
    assert_eq!(by_file_extracts, 0);
    assert_eq!(
        serde_json::from_slice::<Value>(&by_file.stdout).unwrap()["blockId"],
        block_id
    );
    assert_eq!(
        saved_note(&project, &block_id)["sourceFingerprint"],
        fingerprint_before
    );
    assert_eq!(
        saved_note(&project, &block_id)["text"],
        "From the facts file"
    );

    fs::write(
        project.0.join("src/lib.rs"),
        "pub fn before() -> u8 { 1 }\npub fn after() -> u8 { 2 }\n",
    )
    .unwrap();
    let persisted = fs::read(project.notes_file()).unwrap();

    let (live, live_extracts) = project.run_traced(&["notes", "list", "--json"], 0);
    assert_eq!(live_extracts, 1);
    let live_note = listed_note(&live.stdout);
    assert_eq!(live_note["stale"], true);
    assert_eq!(live_note["sourceFingerprint"], fingerprint_before);
    assert_eq!(live_note["text"], "From the facts file");

    let (stale_against_old, old_extracts) =
        project.run_traced(&["notes", "list", "--json", "--map", &before_arg], 0);
    assert_eq!(old_extracts, 0);
    let old_note = listed_note(&stale_against_old.stdout);
    assert_eq!(old_note["stale"], false);
    assert_eq!(old_note["sourceFingerprint"], fingerprint_before);

    let (after, after_extracts) = project.extract("after.facts.json");
    assert_eq!(after_extracts, 1);
    let (after_id, fingerprint_after) = block_for_source(&after, "src/lib.rs");
    assert_eq!(after_id, block_id);
    assert_ne!(fingerprint_after, fingerprint_before);
    let after_path = project.0.join("after.facts.json");
    let after_arg = after_path.to_string_lossy().into_owned();

    let (checked, checked_extracts) = project.run_traced(
        &["notes", "list", "--check", "--map", &after_arg, "--json"],
        5,
    );
    assert_eq!(checked_extracts, 0);
    let checked_note = listed_note(&checked.stdout);
    assert_eq!(checked_note["stale"], true);
    assert_eq!(checked_note["text"], "From the facts file");
    assert_eq!(checked_note["sourceFingerprint"], fingerprint_before);
    assert!(String::from_utf8_lossy(&checked.stderr).contains("1 stale project note"));
    assert_eq!(fs::read(project.notes_file()).unwrap(), persisted);

    let (human, human_extracts) =
        project.run_traced(&["notes", "list", "--check", "--map", &after_arg], 5);
    assert_eq!(human_extracts, 0);
    let human_stdout = String::from_utf8(human.stdout).unwrap();
    assert!(human_stdout.starts_with(&format!("[stale] {block_id} ")));
    assert!(human_stdout.contains("From the facts file"));
    assert!(String::from_utf8_lossy(&human.stderr).contains("1 stale project note"));
    assert_eq!(fs::read(project.notes_file()).unwrap(), persisted);

    let (rewritten, rewritten_extracts) = project.run_traced(
        &[
            "notes",
            "set",
            "--replace",
            "--map",
            &before_arg,
            "--json",
            &block_id,
            "Still the old map",
        ],
        0,
    );
    assert_eq!(rewritten_extracts, 0);
    let result: Value = serde_json::from_slice(&rewritten.stdout).unwrap();
    assert_eq!(result["blockId"], block_id);
    assert_eq!(result["text"], "Still the old map");
    assert_eq!(result["author"], "unknown");
    assert!(result["updatedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        saved_note(&project, &block_id)["updatedAt"],
        result["updatedAt"]
    );
    assert_eq!(
        saved_note(&project, &block_id)["sourceFingerprint"],
        fingerprint_before
    );
    assert_eq!(saved_note(&project, &block_id)["text"], "Still the old map");
    let (live_after_set, live_after_set_extracts) =
        project.run_traced(&["notes", "list", "--json"], 0);
    assert_eq!(live_after_set_extracts, 1);
    let live_after = listed_note(&live_after_set.stdout);
    assert_eq!(live_after["stale"], true);
    assert_eq!(live_after["sourceFingerprint"], fingerprint_before);
    assert_eq!(live_after["text"], "Still the old map");
}

#[test]
fn remove_does_not_extract() {
    let project = Project::new();
    let (facts, _) = project.extract("facts.json");
    let (block_id, fingerprint) = block_for_source(&facts, "src/lib.rs");
    let (_, set_extracts) = project.run_traced(&["notes", "set", &block_id, "Keep this note"], 0);
    assert_eq!(set_extracts, 1);
    assert_eq!(
        saved_note(&project, &block_id)["sourceFingerprint"],
        fingerprint
    );

    let (removed, removed_extracts) = project.run_traced(&["notes", "rm", &block_id], 0);
    assert_eq!(removed_extracts, 0);
    assert_eq!(
        String::from_utf8(removed.stdout).unwrap(),
        format!("Removed note for `{block_id}`.\n")
    );
    let (listed, listed_extracts) = project.run_traced(&["notes", "list", "--json"], 0);
    assert_eq!(listed_extracts, 1);
    assert_eq!(listed.stdout, b"[]\n");
}

#[test]
fn invalid_map_file_fails_without_writing_notes() {
    let project = Project::new();
    let missing = project.0.join("missing.facts.json");
    let missing_arg = missing.to_string_lossy().into_owned();
    let (missing_output, missing_extracts) =
        project.run_traced(&["notes", "list", "--map", &missing_arg, "--json"], 1);
    assert_eq!(missing_extracts, 0);
    assert!(missing_output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&missing_output.stderr).contains("Could not read map file"));
    assert!(!project.notes_file().exists());

    let broken = project.0.join("broken.facts.json");
    fs::write(&broken, "{").unwrap();
    let broken_arg = broken.to_string_lossy().into_owned();
    let (broken_output, broken_extracts) = project.run_traced(
        &[
            "notes",
            "set",
            "--map",
            &broken_arg,
            "module:missing",
            "text",
        ],
        1,
    );
    assert_eq!(broken_extracts, 0);
    assert!(broken_output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&broken_output.stderr).contains("Could not parse map file"));
    assert!(!project.notes_file().exists());

    let unversioned = project.0.join("unversioned.facts.json");
    fs::write(&unversioned, r#"{"blocks":[]}"#).unwrap();
    let unversioned_arg = unversioned.to_string_lossy().into_owned();
    let (unversioned_output, _) =
        project.run_traced(&["notes", "list", "--map", &unversioned_arg], 1);
    assert!(String::from_utf8_lossy(&unversioned_output.stderr).contains("has no schema version"));

    let future = project.0.join("future.facts.json");
    fs::write(&future, r#"{"schemaVersion":2,"blocks":[]}"#).unwrap();
    let future_arg = future.to_string_lossy().into_owned();
    let (future_output, future_extracts) =
        project.run_traced(&["notes", "list", "--json", "--map", &future_arg], 1);
    assert_eq!(future_extracts, 0);
    assert!(future_output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&future_output.stderr).contains("unsupported schema version 2"));

    let incomplete = project.0.join("incomplete.facts.json");
    fs::write(
        &incomplete,
        r#"{"schemaVersion":1,"blocks":[{"id":"module:map-reuse:crate root","label":"crate root"}]}"#,
    )
    .unwrap();
    let incomplete_arg = incomplete.to_string_lossy().into_owned();
    let (incomplete_output, _) = project.run_traced(
        &[
            "notes",
            "set",
            "--map",
            &incomplete_arg,
            "--json",
            "module:map-reuse:crate root",
            "text",
        ],
        1,
    );
    assert!(incomplete_output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&incomplete_output.stderr).contains("has no fingerprint"));
    assert!(!project.notes_file().exists());
}

#[test]
fn map_option_rejects_repeat_removal_and_a_missing_path() {
    let project = Project::new();
    for arguments in [
        vec!["notes", "list", "--map", "a.json", "--map", "b.json"],
        vec!["notes", "list", "--map"],
        vec!["notes", "list", "--map", ""],
        vec![
            "notes",
            "rm",
            "module:map-reuse:crate root",
            "--map",
            "a.json",
        ],
        vec!["notes", "set", "--file", "src/lib.rs", "--map"],
    ] {
        let (output, extracts) = project.run_traced(&arguments, 2);
        assert_eq!(extracts, 0, "{arguments:?}");
        assert!(output.stdout.is_empty(), "{arguments:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("lightwell:"),
            "{arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!project.notes_file().exists());
    }
    let (repeated, _) = project.run_traced(
        &[
            "notes", "set", "--map", "a.json", "--map", "b.json", "id", "text",
        ],
        2,
    );
    assert!(String::from_utf8_lossy(&repeated.stderr).contains("may appear only once"));
    let (removed, _) = project.run_traced(
        &[
            "notes",
            "rm",
            "--map",
            "a.json",
            "module:map-reuse:crate root",
        ],
        2,
    );
    assert!(String::from_utf8_lossy(&removed.stderr).contains("--map is only available"));
}

#[test]
fn help_lists_the_map_option() {
    let output = Command::new(env!("CARGO_BIN_EXE_lightwell"))
        .arg("help")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("notes list [-C|--repo <path>] [--json] [--check] [--map <facts.json>]")
    );
    assert!(stdout.contains(
        "notes set [-C|--repo <path>] [--replace] [--json] [--map <facts.json>] <block-id> <text...>"
    ));
    assert!(stdout.contains(
        "notes set [-C|--repo <path>] --file <path> [--replace] [--json] [--map <facts.json>] <text...>"
    ));
    assert!(!stdout.contains("notes rm [--json] [--map"));
}
