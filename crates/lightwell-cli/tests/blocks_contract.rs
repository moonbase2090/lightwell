use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

const ROOT_BLOCK: &str = "module:blocks-fixture:crate root";
const EXTRA_BLOCK: &str = "module:blocks-fixture:crate root::extra";
const JOB_BLOCK: &str = "module:python:scripts-job";
const KEEP_BLOCK: &str = "module:python:scripts-job-keep:def";
const ADDED_BLOCK: &str = "module:python:scripts-job-added:def";
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "lightwell-cli-blocks-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"blocks-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "pub mod extra;\npub fn root() {}\n",
        )
        .unwrap();
        fs::write(root.join("src/extra.rs"), "pub fn extra() {}\n").unwrap();
        fs::write(
            root.join("scripts/job.py"),
            "def keep():\n    return 1\ndef added():\n    return 4\n",
        )
        .unwrap();
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

    fn error(&self, arguments: &[&str], exit: i32, diagnostic: &str) -> String {
        let output = self.run(arguments, exit);
        assert!(output.stdout.is_empty(), "{:?}", output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(stderr.contains(diagnostic), "{stderr}");
        stderr
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn blocks_lists_actual_ids_in_map_order() {
    let project = Project::new();
    let human = String::from_utf8(project.run(&["blocks"], 0).stdout).unwrap();
    let extra_line = format!("{EXTRA_BLOCK}\textra\tmodule\tsrc/extra.rs");
    assert!(human.contains(&extra_line), "{human}");
    assert!(
        human.contains(&format!("{KEEP_BLOCK}\tkeep\tmodule\tscripts/job.py")),
        "{human}"
    );
    let root_at = human.find(ROOT_BLOCK).unwrap();
    let extra_at = human.find(EXTRA_BLOCK).unwrap();
    let job_at = human.find(JOB_BLOCK).unwrap();
    assert!(root_at < extra_at && extra_at < job_at, "{human}");

    let blocks = project.json(&["blocks", "--json"]);
    let entries = blocks.as_array().unwrap();
    let extra = entries
        .iter()
        .find(|entry| entry["blockId"] == EXTRA_BLOCK)
        .expect("extra block listed");
    assert_eq!(extra["label"], "extra");
    assert_eq!(extra["kind"], "module");
    assert_eq!(extra["sourcePath"], "src/extra.rs");
    assert_eq!(extra["parentId"], ROOT_BLOCK);
    let ids: Vec<&str> = entries
        .iter()
        .map(|entry| entry["blockId"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&ADDED_BLOCK), "{ids:?}");
}

#[test]
fn blocks_file_filter_is_exact() {
    let project = Project::new();
    let human =
        String::from_utf8(project.run(&["blocks", "--file", "src/extra.rs"], 0).stdout).unwrap();
    assert_eq!(
        human.trim_end_matches('\n'),
        format!("{EXTRA_BLOCK}\textra\tmodule\tsrc/extra.rs")
    );
    let filtered = project.json(&["blocks", "--json", "--file", "scripts/job.py"]);
    let ids: Vec<&str> = filtered
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["blockId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [JOB_BLOCK, KEEP_BLOCK, ADDED_BLOCK]);
    assert_eq!(
        project.json(&["blocks", "--json", "--file", "job.py"]),
        json!([])
    );
    assert_eq!(
        project
            .run(&["blocks", "--file", "src/missing.rs"], 0)
            .stdout,
        b""
    );
}

#[test]
fn notes_set_file_unique_match_saves() {
    let project = Project::new();
    let set = project.json(&[
        "notes",
        "set",
        "--file",
        "src/extra.rs",
        "--json",
        "File note",
    ]);
    assert_eq!(set["blockId"], EXTRA_BLOCK);
    assert_eq!(set["text"], "File note");
    assert_eq!(set["author"], "unknown");
    let set_updated = set["updatedAt"]
        .as_str()
        .expect("set JSON includes updatedAt");
    assert!(
        set_updated.ends_with('Z') && set_updated.len() == 20,
        "updatedAt should be RFC3339 UTC with seconds: {set_updated}"
    );
    let notes = project.json(&["notes", "list", "--json"]);
    assert_eq!(notes[0]["blockId"], EXTRA_BLOCK);
    let saved: Value =
        serde_json::from_slice(&fs::read(project.0.join(".lightwell/notes.json")).unwrap())
            .unwrap();
    assert_eq!(saved["notes"][EXTRA_BLOCK]["text"], "File note");
    assert_eq!(saved["notes"][EXTRA_BLOCK]["author"], "unknown");
    assert_eq!(saved["notes"][EXTRA_BLOCK]["updatedAt"], set_updated);

    let absolute = project.0.join("src/lib.rs");
    let root_set = project.json(&[
        "notes",
        "set",
        "--json",
        "--file",
        absolute.to_str().unwrap(),
        "Root note",
    ]);
    assert_eq!(root_set["blockId"], ROOT_BLOCK);
    assert_eq!(root_set["text"], "Root note");
    assert!(root_set.get("author").and_then(Value::as_str).is_some());
    assert!(root_set.get("updatedAt").and_then(Value::as_str).is_some());
}

#[test]
fn file_paths_with_parent_components_resolve_like_their_canonical_form() {
    let project = Project::new();
    let canonical_root = fs::canonicalize(&project.0).unwrap();
    let separator = std::path::MAIN_SEPARATOR;
    let mut absolute_with_parent = canonical_root.into_os_string();
    absolute_with_parent.push(format!(
        "{separator}src{separator}..{separator}src{separator}extra.rs"
    ));
    let absolute_with_parent = absolute_with_parent.to_string_lossy().into_owned();
    assert!(
        std::path::Path::new(&absolute_with_parent)
            .components()
            .any(|component| component == std::path::Component::ParentDir),
        "{absolute_with_parent}"
    );

    let filtered = project.json(&["blocks", "--json", "--file", &absolute_with_parent]);
    let ids: Vec<&str> = filtered
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["blockId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [EXTRA_BLOCK]);

    let parent_set = project.json(&[
        "notes",
        "set",
        "--json",
        "--file",
        &absolute_with_parent,
        "Parent path note",
    ]);
    assert_eq!(parent_set["blockId"], EXTRA_BLOCK);
    assert_eq!(parent_set["text"], "Parent path note");
    assert_eq!(parent_set["author"], "unknown");
    let parent_updated = parent_set["updatedAt"]
        .as_str()
        .expect("set JSON includes updatedAt");
    assert!(
        parent_updated.ends_with('Z') && parent_updated.len() == 20,
        "updatedAt should be RFC3339 UTC with seconds: {parent_updated}"
    );
    let saved: Value =
        serde_json::from_slice(&fs::read(project.0.join(".lightwell/notes.json")).unwrap())
            .unwrap();
    assert_eq!(saved["notes"][EXTRA_BLOCK]["text"], "Parent path note");
    assert_eq!(saved["notes"][EXTRA_BLOCK]["author"], "unknown");
    assert_eq!(saved["notes"][EXTRA_BLOCK]["updatedAt"], parent_updated);

    let relative_filtered = project.json(&["blocks", "--json", "--file", "src/../src/extra.rs"]);
    assert_eq!(relative_filtered, filtered);
}

#[test]
fn notes_set_file_ambiguous_match_saves_nothing() {
    let project = Project::new();
    let stderr = project.error(
        &[
            "notes",
            "set",
            "--file",
            "scripts/job.py",
            "--json",
            "Which block?",
        ],
        2,
        "matches 3 blocks",
    );
    for candidate in [JOB_BLOCK, KEEP_BLOCK, ADDED_BLOCK] {
        assert!(stderr.contains(candidate), "{stderr}");
    }
    assert!(!project.0.join(".lightwell/notes.json").exists());
}

#[test]
fn notes_set_file_without_match_suggests_paths() {
    let project = Project::new();
    let stderr = project.error(
        &["notes", "set", "--file", "job.py", "Note text"],
        4,
        "No block for file `job.py`",
    );
    assert!(stderr.contains("scripts/job.py"), "{stderr}");
    project.error(
        &["notes", "set", "--file", "src/nope.rs", "Note text"],
        4,
        "No block for file",
    );
    assert!(!project.0.join(".lightwell/notes.json").exists());
}

#[test]
fn unknown_block_ids_get_did_you_mean_suggestions() {
    let project = Project::new();
    let stderr = project.error(
        &[
            "notes",
            "set",
            "module:blocks-fixture:crate root::extr",
            "Note text",
        ],
        4,
        "No block with ID",
    );
    assert!(
        stderr.contains(&format!("Did you mean `{EXTRA_BLOCK}`?")),
        "{stderr}"
    );
    let stderr = project.error(
        &["notes", "set", "--json", "keep", "Note text"],
        4,
        "No block with ID",
    );
    assert!(
        stderr.contains(&format!("Did you mean `{KEEP_BLOCK}`?")),
        "{stderr}"
    );
    let stderr = project.error(
        &["notes", "set", "qqqqqq", "Note text"],
        4,
        "No block with ID",
    );
    assert!(!stderr.contains("Did you mean"), "{stderr}");
    assert!(!project.0.join(".lightwell/notes.json").exists());
}

#[test]
fn file_and_blocks_usage_errors_exit_two() {
    let project = Project::new();
    for arguments in [
        vec!["blocks", "--unknown"],
        vec!["blocks", "--json", "--json"],
        vec!["blocks", "--file"],
        vec!["blocks", "--file", "src/lib.rs", "--file", "src/extra.rs"],
        vec!["blocks", "unexpected"],
        vec!["notes", "set", "--file"],
        vec![
            "notes",
            "set",
            "--file",
            "src/lib.rs",
            "--file",
            "src/extra.rs",
            "text",
        ],
        vec!["notes", "rm", EXTRA_BLOCK, "--file", "src/extra.rs"],
        vec!["notes", "list", "--file", "src/extra.rs"],
        vec!["notes", "set", "--file", "src/extra.rs"],
    ] {
        project.error(&arguments, 2, "lightwell:");
    }
    assert!(!project.0.join(".lightwell/notes.json").exists());
}

#[test]
fn blocks_outside_a_project_fails_without_stdout() {
    let root =
        std::env::temp_dir().join(format!("lightwell-cli-blocks-bare-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir(&root).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lightwell"))
        .current_dir(&root)
        .args(["blocks", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.is_empty());
    let _ = fs::remove_dir_all(&root);
}
