//! Map a git commit's changes onto workspace map blocks.
//!
//! File-backed blocks (crates, targets, Rust modules, Python and web modules)
//! take the whole file's line counts. Python and TypeScript symbol blocks share
//! their module's file. Each symbol owns the lines from its definition to the
//! next top-level symbol, measured in the file as it was at the commit.

use crate::extract::block_base;
use crate::facts::{FactBlock, FactMap};
use crate::python_source::parse_python_source;
use crate::typescript_source::parse_typescript_source;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::process::Command;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    /// Committer time, Unix seconds.
    pub timestamp: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Path after the commit, relative to the workspace root, with `/` separators.
    pub path: String,
    /// Path before a rename.
    pub old_path: Option<String>,
    pub added: usize,
    pub removed: usize,
    pub binary: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockChange {
    pub block_id: String,
    pub added: usize,
    pub removed: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChanges {
    /// When set, changes are everything after this commit through `commit`.
    pub base_commit: Option<CommitSummary>,
    pub commit: CommitSummary,
    /// Every changed file under the workspace root, mapped or not.
    pub files: Vec<FileChange>,
    /// Blocks in the map with at least one changed line, in map order.
    pub blocks: Vec<BlockChange>,
}

#[derive(Debug)]
pub enum DiffError {
    InvalidCommit(String),
    /// `base` is not an ancestor of `head`, or the two commits are the same.
    InvalidCommitRange { base: String, head: String },
    BlockNotFound(String),
    BlockHasNoSource(String),
    /// The commit did not touch the block's file.
    FileUnchanged(String),
    Git {
        command: String,
        message: String,
    },
}

impl Display for DiffError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCommit(commit) => {
                write!(formatter, "`{commit}` is not a commit in this repository.")
            }
            Self::InvalidCommitRange { base, head } => write!(
                formatter,
                "`{base}` is not an ancestor of `{head}` in this repository."
            ),
            Self::BlockNotFound(id) => write!(formatter, "Block {id} is not in the workspace map."),
            Self::BlockHasNoSource(id) => {
                write!(formatter, "Block {id} has no source file to compare.")
            }
            Self::FileUnchanged(path) => write!(formatter, "This commit did not change {path}."),
            Self::Git { command, message } => write!(formatter, "git {command} failed: {message}"),
        }
    }
}

impl Error for DiffError {}

/// The most recent commits that touch the workspace root, newest first.
pub fn recent_commits(root: &Path, limit: usize) -> Result<Vec<CommitSummary>, DiffError> {
    let output = git(
        root,
        &[
            "log",
            &format!("--max-count={limit}"),
            "--format=%H%x1f%h%x1f%ct%x1f%s%x1e",
            "--",
            ".",
        ],
    )?;
    Ok(output
        .split('\u{1e}')
        .filter_map(|record| parse_commit_record(record.trim_start_matches('\n')))
        .collect())
}

/// What `commit` changed, relative to its first parent, mapped onto `map`.
pub fn commit_changes(
    root: &Path,
    map: &FactMap,
    commit: &str,
) -> Result<CommitChanges, DiffError> {
    commit_changes_for(root, map, commit, None)
}

/// Map changes onto `map` for one commit or for everything after `base` through `head`.
pub fn commit_changes_for(
    root: &Path,
    map: &FactMap,
    head: &str,
    base: Option<&str>,
) -> Result<CommitChanges, DiffError> {
    let head_summary = resolve_commit(root, head)?;
    let Some(base) = base.filter(|value| !value.is_empty()) else {
        let (files, hunks) = single_commit_diff(root, &head_summary.id)?;
        let blocks = attribute_changes(map, &files, &hunks, |path| {
            git(root, &["show", &format!("{}:./{path}", head_summary.id)]).ok()
        });
        return Ok(CommitChanges {
            base_commit: None,
            commit: head_summary,
            files,
            blocks,
        });
    };
    let base_summary = resolve_commit(root, base)?;
    ensure_ancestor(root, &base_summary.id, &head_summary.id)?;
    let revision = format!("{}..{}", base_summary.id, head_summary.id);
    let (files, hunks) = revision_diff(root, &revision)?;
    let blocks = attribute_changes(map, &files, &hunks, |path| {
        git(root, &["show", &format!("{}:./{path}", head_summary.id)]).ok()
    });
    Ok(CommitChanges {
        base_commit: Some(base_summary),
        commit: head_summary,
        files,
        blocks,
    })
}

fn single_commit_diff(root: &Path, commit: &str) -> Result<(Vec<FileChange>, HashMap<String, Vec<Hunk>>), DiffError> {
    let range = diff_tree_prefix();
    let numstat = git(
        root,
        &[&range[..], &["--numstat", "-z", commit]].concat(),
    )?;
    let patch = git(
        root,
        &[
            &range[..],
            &["-p", "-U0", "--no-color", "--no-ext-diff", commit],
        ]
        .concat(),
    )?;
    Ok((parse_numstat(&numstat), parse_hunks(&patch)))
}

fn revision_diff(root: &Path, revision: &str) -> Result<(Vec<FileChange>, HashMap<String, Vec<Hunk>>), DiffError> {
    let numstat = git(
        root,
        &[
            "diff",
            "-M",
            "--relative",
            "--numstat",
            "-z",
            revision,
            "--",
            ".",
        ],
    )?;
    let patch = git(
        root,
        &[
            "diff",
            "-M",
            "--relative",
            "-p",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            revision,
            "--",
            ".",
        ],
    )?;
    Ok((parse_numstat(&numstat), parse_hunks(&patch)))
}

fn diff_tree_prefix() -> [&'static str; 6] {
    [
        "diff-tree",
        "-r",
        "--root",
        "-M",
        "--no-commit-id",
        "--relative",
    ]
}

fn ensure_ancestor(root: &Path, base: &str, head: &str) -> Result<(), DiffError> {
    if base == head {
        return Err(DiffError::InvalidCommitRange {
            base: base.to_owned(),
            head: head.to_owned(),
        });
    }
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .arg("-C")
        .arg(root)
        .args(["merge-base", "--is-ancestor", base, head]);
    let output = command.output().map_err(|error| DiffError::Git {
        command: "merge-base".to_owned(),
        message: error.to_string(),
    })?;
    if !output.status.success() {
        return Err(DiffError::InvalidCommitRange {
            base: base.to_owned(),
            head: head.to_owned(),
        });
    }
    Ok(())
}

/// One block's file before and after a commit, for a side-by-side diff.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDiffDocument {
    pub commit: CommitSummary,
    /// Path after the commit, relative to the workspace root.
    pub path: String,
    /// Path before the commit when the file was renamed.
    pub original_path: Option<String>,
    /// The file at the commit's first parent; empty when the commit added it.
    pub original: String,
    /// The file at the commit; empty when the commit deleted it.
    pub modified: String,
    /// Line in `modified` to reveal: the block's first changed line, else its start.
    pub line: usize,
}

/// The before and after text of `block_id`'s file in `commit`.
pub fn block_diff(
    root: &Path,
    map: &FactMap,
    commit: &str,
    block_id: &str,
) -> Result<BlockDiffDocument, DiffError> {
    block_diff_for(root, map, commit, None, block_id)
}

/// Before and after text for `block_id` across a commit or a `base..head` range.
pub fn block_diff_for(
    root: &Path,
    map: &FactMap,
    head: &str,
    base: Option<&str>,
    block_id: &str,
) -> Result<BlockDiffDocument, DiffError> {
    let head_summary = resolve_commit(root, head)?;
    let block = map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id)
        .ok_or_else(|| DiffError::BlockNotFound(block_id.to_owned()))?;
    let path = block_base(block)
        .source_path
        .as_deref()
        .map(normalized)
        .ok_or_else(|| DiffError::BlockHasNoSource(block_id.to_owned()))?;

    let (file, hunks) = match base.filter(|value| !value.is_empty()) {
        None => {
            let range = diff_tree_prefix();
            let numstat = git(
                root,
                &[&range[..], &["--numstat", "-z", &head_summary.id]].concat(),
            )?;
            let file = parse_numstat(&numstat)
                .into_iter()
                .find(|file| file.path == path)
                .ok_or_else(|| DiffError::FileUnchanged(path.clone()))?;
            let patch = git(
                root,
                &[
                    &range[..],
                    &[
                        "-p",
                        "-U0",
                        "--no-color",
                        "--no-ext-diff",
                        &head_summary.id,
                        "--",
                        &path,
                    ],
                ]
                .concat(),
            )?;
            (file, parse_hunks(&patch).remove(&path).unwrap_or_default())
        }
        Some(base) => {
            let base_summary = resolve_commit(root, base)?;
            ensure_ancestor(root, &base_summary.id, &head_summary.id)?;
            let revision = format!("{}..{}", base_summary.id, head_summary.id);
            let numstat = git(
                root,
                &[
                    "diff",
                    "-M",
                    "--relative",
                    "--numstat",
                    "-z",
                    &revision,
                    "--",
                    &path,
                ],
            )?;
            let file = parse_numstat(&numstat)
                .into_iter()
                .find(|file| file.path == path)
                .ok_or_else(|| DiffError::FileUnchanged(path.clone()))?;
            let patch = git(
                root,
                &[
                    "diff",
                    "-M",
                    "--relative",
                    "-p",
                    "-U0",
                    "--no-color",
                    "--no-ext-diff",
                    &revision,
                    "--",
                    &path,
                ],
            )?;
            (file, parse_hunks(&patch).remove(&path).unwrap_or_default())
        }
    };

    let modified = git(root, &["show", &format!("{}:./{path}", head_summary.id)]).unwrap_or_default();
    let original_path = file.old_path.clone().unwrap_or_else(|| path.clone());
    let original = match base.filter(|value| !value.is_empty()) {
        None => git(
            root,
            &["show", &format!("{}^:./{original_path}", head_summary.id)],
        )
        .unwrap_or_default(),
        Some(base) => {
            let base_summary = resolve_commit(root, base)?;
            git(root, &["show", &format!("{}:./{original_path}", base_summary.id)])
                .unwrap_or_default()
        }
    };

    let first_change = hunks.iter().map(|hunk| hunk.new_start.max(1)).min();
    let parent_shares_file = block_base(block)
        .parent_id
        .as_deref()
        .and_then(|parent| {
            map.blocks
                .iter()
                .find(|candidate| block_base(candidate).id == parent)
        })
        .is_some_and(|parent| {
            block_base(parent)
                .source_path
                .as_deref()
                .map(normalized)
                .as_deref()
                == Some(path.as_str())
        });
    let line = if parent_shares_file {
        match symbol_spans(&path, &modified).get(block_base(block).label.as_str()) {
            Some(&(start, end)) => hunks
                .iter()
                .map(|hunk| hunk.new_start.max(1))
                .find(|line| (start..=end).contains(line))
                .unwrap_or(start),
            None => first_change.unwrap_or(1),
        }
    } else {
        first_change.unwrap_or(1)
    };

    Ok(BlockDiffDocument {
        commit: head_summary,
        path,
        original_path: file.old_path,
        original,
        modified,
        line,
    })
}

fn resolve_commit(root: &Path, commit: &str) -> Result<CommitSummary, DiffError> {
    // A leading dash would be read as an option.
    if commit.is_empty() || commit.starts_with('-') {
        return Err(DiffError::InvalidCommit(commit.to_owned()));
    }
    let output = git(
        root,
        &[
            "log",
            "-1",
            "--format=%H%x1f%h%x1f%ct%x1f%s",
            &format!("{commit}^{{commit}}"),
            "--",
        ],
    )
    .map_err(|_| DiffError::InvalidCommit(commit.to_owned()))?;
    parse_commit_record(output.trim_end())
        .ok_or_else(|| DiffError::InvalidCommit(commit.to_owned()))
}

fn parse_commit_record(record: &str) -> Option<CommitSummary> {
    let mut fields = record.splitn(4, '\u{1f}');
    let id = fields.next()?.trim().to_owned();
    if id.is_empty() {
        return None;
    }
    Some(CommitSummary {
        id,
        short_id: fields.next()?.to_owned(),
        timestamp: fields.next()?.parse().ok()?,
        summary: fields.next()?.trim_end().to_owned(),
    })
}

fn git(root: &Path, args: &[&str]) -> Result<String, DiffError> {
    let mut command = Command::new("git");
    // The desktop app has no console; without this each git call flashes one.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotePath=false"])
        .args(args);
    let output = command.output().map_err(|error| DiffError::Git {
        command: args.first().copied().unwrap_or_default().to_owned(),
        message: error.to_string(),
    })?;
    if !output.status.success() {
        return Err(DiffError::Git {
            command: args.first().copied().unwrap_or_default().to_owned(),
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `--numstat -z`: `added\tremoved\tpath\0`, or for a rename `added\tremoved\t\0old\0new\0`.
/// Binary files report `-` for both counts.
fn parse_numstat(output: &str) -> Vec<FileChange> {
    let mut fields = output.split('\0');
    let mut files = Vec::new();
    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let binary = added == "-" || removed == "-";
        let (path, old_path) = if path.is_empty() {
            let old = fields.next().unwrap_or_default().to_owned();
            (fields.next().unwrap_or_default().to_owned(), Some(old))
        } else {
            (path.to_owned(), None)
        };
        files.push(FileChange {
            path,
            old_path,
            added: added.parse().unwrap_or(0),
            removed: removed.parse().unwrap_or(0),
            binary,
        });
    }
    files
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Hunk {
    old_count: usize,
    new_start: usize,
    new_count: usize,
}

/// Hunks per post-commit path from `-p -U0` output.
fn parse_hunks(patch: &str) -> HashMap<String, Vec<Hunk>> {
    let mut hunks: HashMap<String, Vec<Hunk>> = HashMap::new();
    let mut current: Option<String> = None;
    for line in patch.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            current = path.strip_prefix("b/").map(str::to_owned);
        } else if let (Some(path), Some(header)) = (current.as_ref(), line.strip_prefix("@@ -")) {
            if let Some(hunk) = parse_hunk_header(header) {
                hunks.entry(path.clone()).or_default().push(hunk);
            }
        }
    }
    hunks
}

/// `a[,b] +c[,d] @@ ...` with counts defaulting to 1.
fn parse_hunk_header(header: &str) -> Option<Hunk> {
    let (old, rest) = header.split_once(" +")?;
    let new = rest.split_once(" @@")?.0;
    let count = |range: &str| -> Option<(usize, usize)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (_, old_count) = count(old)?;
    let (new_start, new_count) = count(new)?;
    Some(Hunk {
        old_count,
        new_start,
        new_count,
    })
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

fn attribute_changes(
    map: &FactMap,
    files: &[FileChange],
    hunks: &HashMap<String, Vec<Hunk>>,
    mut source_at_commit: impl FnMut(&str) -> Option<String>,
) -> Vec<BlockChange> {
    let by_id: HashMap<&str, &FactBlock> = map
        .blocks
        .iter()
        .map(|block| (block_base(block).id.as_str(), block))
        .collect();
    let path_of = |block: &FactBlock| block_base(block).source_path.as_deref().map(normalized);
    let mut counts: BTreeMap<usize, (usize, usize)> = BTreeMap::new();

    for file in files {
        let blocks: Vec<(usize, &FactBlock)> = map
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| path_of(block).as_deref() == Some(file.path.as_str()))
            .collect();
        if blocks.is_empty() {
            continue;
        }
        let is_symbol = |block: &FactBlock| {
            block_base(block)
                .parent_id
                .as_deref()
                .and_then(|parent| by_id.get(parent))
                .is_some_and(|parent| path_of(parent) == path_of(block))
        };
        let mut symbols = Vec::new();
        for (index, block) in &blocks {
            if is_symbol(block) {
                symbols.push((*index, *block));
            } else if file.added + file.removed > 0 {
                let entry = counts.entry(*index).or_default();
                entry.0 += file.added;
                entry.1 += file.removed;
            }
        }
        if symbols.is_empty() {
            continue;
        }
        let Some(file_hunks) = hunks.get(&file.path) else {
            continue;
        };
        let Some(source) = source_at_commit(&file.path) else {
            continue;
        };
        let spans = symbol_spans(&file.path, &source);
        for (index, block) in symbols {
            let Some(&(start, end)) = spans.get(block_base(block).label.as_str()) else {
                continue;
            };
            let (mut added, mut removed) = (0, 0);
            for hunk in file_hunks {
                let first = hunk.new_start;
                let last = hunk.new_start + hunk.new_count;
                added += (first.max(start)..last.min(end + 1)).len();
                // A deletion sits after line new_start; count it where it was removed.
                let anchor = if hunk.new_count == 0 {
                    hunk.new_start + 1
                } else {
                    hunk.new_start
                };
                if (start..=end).contains(&anchor) {
                    removed += hunk.old_count;
                }
            }
            if added + removed > 0 {
                let entry = counts.entry(index).or_default();
                entry.0 += added;
                entry.1 += removed;
            }
        }
    }

    counts
        .into_iter()
        .map(|(index, (added, removed))| BlockChange {
            block_id: block_base(&map.blocks[index]).id.clone(),
            added,
            removed,
        })
        .collect()
}

/// Line span of each top-level symbol: its definition line through the line
/// before the next symbol, or the end of the file.
fn symbol_spans(path: &str, source: &str) -> HashMap<String, (usize, usize)> {
    let lower = path.to_ascii_lowercase();
    let mut lines: Vec<(usize, String)> = if lower.ends_with(".py") || lower.ends_with(".pyi") {
        parse_python_source(source)
            .1
            .into_iter()
            .map(|symbol| (symbol.line, symbol.name))
            .collect()
    } else if [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        parse_typescript_source(source)
            .1
            .into_iter()
            .map(|symbol| (symbol.line, symbol.name))
            .collect()
    } else {
        Vec::new()
    };
    lines.sort();
    let file_end = source.lines().count().max(1);
    let mut spans = HashMap::new();
    for (position, (line, name)) in lines.iter().enumerate() {
        let end = lines
            .get(position + 1)
            .map_or(file_end, |(next, _)| next.saturating_sub(1).max(*line));
        spans.entry(name.clone()).or_insert((*line, end));
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::{
        block_diff, block_diff_for, commit_changes, commit_changes_for, parse_hunk_header,
        parse_numstat, recent_commits, symbol_spans, DiffError, Hunk,
    };
    use crate::extract::{block_base, extract_cargo_map};
    use crate::facts::FactBlock;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("lightwell-{label}-{}-{unique}", std::process::id()))
    }

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=Lightwell Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.autocrlf=false",
            ])
            .args(args)
            .status()
            .expect("git should run");
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn hunk_headers_default_counts_to_one() {
        assert_eq!(
            parse_hunk_header("3,2 +4 @@ fn x"),
            Some(Hunk {
                old_count: 2,
                new_start: 4,
                new_count: 1
            })
        );
        assert_eq!(
            parse_hunk_header("10 +9,0 @@"),
            Some(Hunk {
                old_count: 1,
                new_start: 9,
                new_count: 0
            })
        );
        assert_eq!(parse_hunk_header("nonsense"), None);
    }

    #[test]
    fn numstat_reads_renames_and_binary_files() {
        let files = parse_numstat("3\t1\tsrc/a.py\0-\t-\tlogo.png\x002\t0\t\0old.py\0new.py\0");
        assert_eq!(files.len(), 3);
        assert_eq!(
            (
                files[0].path.as_str(),
                files[0].added,
                files[0].removed,
                files[0].binary
            ),
            ("src/a.py", 3, 1, false)
        );
        assert!(files[1].binary);
        assert_eq!(
            (files[2].path.as_str(), files[2].old_path.as_deref()),
            ("new.py", Some("old.py"))
        );
    }

    #[test]
    fn symbol_spans_run_to_the_next_top_level_symbol() {
        let spans = symbol_spans(
            "job.py",
            "import os\n\ndef plan():\n    return 1\n\n\ndef merge():\n    return 2\n",
        );
        assert_eq!(spans.get("plan"), Some(&(3, 6)));
        assert_eq!(spans.get("merge"), Some(&(7, 8)));
    }

    #[test]
    fn a_commit_lights_only_the_symbols_and_files_it_changed() {
        let root = temporary_directory("commit-diff");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"diff-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), "pub mod untouched;\n").unwrap();
        fs::write(root.join("src/untouched.rs"), "pub fn value() {}\n").unwrap();
        fs::write(
            root.join("scripts/job.py"),
            "import os\n\ndef plan():\n    return 1\n\n\ndef merge():\n    return 2\n",
        )
        .unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Initial"]);
        fs::write(
            root.join("scripts/job.py"),
            "import os\n\ndef plan():\n    return 1\n\n\ndef merge():\n    total = 2\n    return total\n",
        )
        .unwrap();
        fs::write(root.join("NOTES.txt"), "not mapped\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Change merge"]);

        let map = extract_cargo_map(&root, None).expect("fixture map should extract");
        let id_of = |label: &str| {
            map.blocks
                .iter()
                .find(|block| {
                    block_base(block).label == label && matches!(block, FactBlock::Module(_))
                })
                .map(|block| block_base(block).id.clone())
                .unwrap_or_else(|| panic!("{label} should be in the map"))
        };

        let commits = recent_commits(&root, 10).unwrap();
        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.summary.as_str())
                .collect::<Vec<_>>(),
            ["Change merge", "Initial"]
        );

        let changes = commit_changes(&root, &map, &commits[0].id).unwrap();
        assert_eq!(changes.base_commit, None);
        assert_eq!(changes.commit.summary, "Change merge");
        let mut paths: Vec<_> = changes
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        paths.sort_unstable();
        assert_eq!(paths, ["NOTES.txt", "scripts/job.py"]);

        let changed: Vec<_> = changes
            .blocks
            .iter()
            .map(|block| (block.block_id.clone(), block.added, block.removed))
            .collect();
        assert!(
            changed.contains(&(id_of("merge"), 2, 1)),
            "merge should own the edit: {changed:?}"
        );
        assert!(
            changed.iter().all(|(id, _, _)| *id != id_of("plan")),
            "plan was not edited: {changed:?}"
        );
        assert!(
            changed.iter().all(|(id, _, _)| *id != id_of("untouched")),
            "untouched.rs was not edited: {changed:?}"
        );

        let merge_diff = block_diff(&root, &map, &commits[0].id, &id_of("merge")).unwrap();
        assert_eq!(merge_diff.path, "scripts/job.py");
        assert!(merge_diff.original.contains("    return 2\n"));
        assert!(merge_diff.modified.contains("    total = 2\n"));
        assert_eq!(merge_diff.line, 8, "merge's first changed line");
        let plan_diff = block_diff(&root, &map, &commits[0].id, &id_of("plan")).unwrap();
        assert_eq!(
            plan_diff.line, 3,
            "plan is unchanged, so its start is revealed"
        );
        let first = block_diff(&root, &map, &commits[1].id, &id_of("merge")).unwrap();
        assert_eq!(first.original, "", "the root commit added the file");
        assert!(matches!(
            block_diff(&root, &map, &commits[0].id, &id_of("untouched")),
            Err(super::DiffError::FileUnchanged(_))
        ));

        assert!(commit_changes(&root, &map, "--help").is_err());
        assert!(commit_changes(&root, &map, "not-a-commit").is_err());

        let ranged = commit_changes_for(&root, &map, &commits[0].id, Some(&commits[1].id)).unwrap();
        assert_eq!(ranged.base_commit.as_ref().map(|c| c.summary.as_str()), Some("Initial"));
        assert_eq!(ranged.commit.summary, "Change merge");
        assert_eq!(ranged.files.len(), changes.files.len());

        fs::write(
            root.join("scripts/job.py"),
            "import os\n\ndef plan():\n    return 99\n\n\ndef merge():\n    total = 2\n    return total\n",
        )
        .unwrap();
        git(&root, &["add", "scripts/job.py"]);
        git(&root, &["commit", "-q", "-m", "Change plan"]);
        let commits = recent_commits(&root, 10).unwrap();
        let span = commit_changes_for(&root, &map, &commits[0].id, Some(&commits[2].id)).unwrap();
        let span_ids: Vec<_> = span
            .blocks
            .iter()
            .map(|block| block.block_id.clone())
            .collect();
        assert!(
            span_ids.contains(&id_of("merge")) && span_ids.contains(&id_of("plan")),
            "range should include edits from both commits: {span_ids:?}"
        );

        let range_diff =
            block_diff_for(&root, &map, &commits[0].id, Some(&commits[2].id), &id_of("plan")).unwrap();
        assert!(range_diff.original.contains("    return 1\n"));
        assert!(range_diff.modified.contains("    return 99\n"));

        assert!(matches!(
            commit_changes_for(&root, &map, &commits[0].id, Some(&commits[0].id)),
            Err(DiffError::InvalidCommitRange { .. })
        ));

        fs::remove_dir_all(root).unwrap();
    }
}
