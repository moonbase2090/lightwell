//! Map a git commit's changes onto workspace map blocks.
//!
//! File-backed blocks (crates, targets, Rust modules, Python and web modules)
//! take the whole file's line counts. Python and TypeScript symbol blocks share
//! their module's file. Each symbol owns the lines from its definition to the
//! next top-level symbol. Additions use the after file; removals use the before file.

mod ranges;
pub use ranges::{resolve_commit_range, CommitRangePreset, ResolvedCommitRange};

use crate::dotnet_source::{parse_csharp_source, parse_vb_source};
use crate::extract::MapExtractionError;
use crate::extract::{block_base, extract_cargo_map, project_manifest};
use crate::facts::{Connection, DependencyScope, FactBlock, FactMap, MapStats};
use crate::go_source::parse_go_source;
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
    pub label: String,
    pub source_path: Option<String>,
    pub parent_id: Option<String>,
    pub state: BlockChangeState,
    pub added: usize,
    pub removed: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockChangeState {
    Added,
    Changed,
    Removed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionChange {
    pub id: String,
    pub source: String,
    pub target: String,
    /// `contains` or `depends_on`.
    pub kind: String,
    /// `added`, `removed`, or `changed`.
    pub state: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChanges {
    /// When set, changes are everything after this commit through `commit`.
    pub base_commit: Option<CommitSummary>,
    pub commit: CommitSummary,
    /// Every changed file under the workspace root, mapped or not.
    pub files: Vec<FileChange>,
    /// Changed blocks in after-map order, followed by removed blocks in before-map order.
    pub blocks: Vec<BlockChange>,
    /// Graph edges that were added, removed, or changed between the before and after maps.
    pub connections: Vec<ConnectionChange>,
}

#[derive(Debug)]
pub enum DiffError {
    InvalidCommit(String),
    /// `base` is not an ancestor of `head`, or the two commits are the same.
    InvalidCommitRange {
        base: String,
        head: String,
    },
    BlockNotFound(String),
    BlockHasNoSource(String),
    /// The commit did not touch the block's file.
    FileUnchanged(String),
    Git {
        command: String,
        message: String,
    },
    MapExtraction(String),
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
            Self::MapExtraction(message) => {
                write!(formatter, "Could not map the workspace: {message}")
            }
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
    let base_summary = base
        .filter(|value| !value.is_empty())
        .map(|base| resolve_commit(root, base))
        .transpose()?;
    if let Some(base) = &base_summary {
        ensure_ancestor(root, &base.id, &head_summary.id)?;
    }
    let before_commit = base_summary
        .as_ref()
        .map(|base| base.id.clone())
        .or_else(|| parent_commit(root, &head_summary.id));
    let (files, hunks) = match &base_summary {
        Some(base) => revision_diff(root, &format!("{}..{}", base.id, head_summary.id))?,
        None => single_commit_diff(root, &head_summary.id)?,
    };
    let project_name = Some(map.project.name.as_str());
    let after_map = extract_map_at_commit(root, &head_summary.id, project_name)?
        .unwrap_or_else(|| empty_map_like(map));
    let before_map = match &before_commit {
        Some(commit) => extract_map_at_commit(root, commit, project_name)?,
        None => None,
    }
    .unwrap_or_else(|| empty_map_like(map));
    let blocks = attribute_changes(
        &before_map,
        &after_map,
        &files,
        &hunks,
        |path| {
            before_commit
                .as_ref()
                .and_then(|commit| git(root, &["show", &format!("{commit}:./{path}")]).ok())
        },
        |path| git(root, &["show", &format!("{}:./{path}", head_summary.id)]).ok(),
    );
    let connections = diff_connections(&before_map.connections, &after_map.connections);
    Ok(CommitChanges {
        base_commit: base_summary,
        commit: head_summary,
        files,
        blocks,
        connections,
    })
}

/// Commits from `commits` that are strict ancestors of `head`, preserving order.
pub fn filter_commits_that_are_ancestors(
    root: &Path,
    head: &str,
    commits: &[CommitSummary],
) -> Result<Vec<CommitSummary>, DiffError> {
    let head_summary = resolve_commit(root, head)?;
    Ok(commits
        .iter()
        .filter(|commit| {
            commit.id != head_summary.id
                && ensure_ancestor(root, &commit.id, &head_summary.id).is_ok()
        })
        .cloned()
        .collect())
}

fn single_commit_diff(
    root: &Path,
    commit: &str,
) -> Result<(Vec<FileChange>, HashMap<String, Vec<Hunk>>), DiffError> {
    let range = diff_tree_prefix();
    let numstat = git(root, &[&range[..], &["--numstat", "-z", commit]].concat())?;
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

fn revision_diff(
    root: &Path,
    revision: &str,
) -> Result<(Vec<FileChange>, HashMap<String, Vec<Hunk>>), DiffError> {
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

fn parent_commit(root: &Path, commit: &str) -> Option<String> {
    git(root, &["rev-parse", &format!("{commit}^")])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn empty_map_like(template: &FactMap) -> FactMap {
    FactMap::schema_v1(
        template.project.clone(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        MapStats::default(),
    )
}

/// Maps the workspace as it was at `commit`, or `None` when the project did not
/// exist yet. The workspace can sit below the repository root, so the map is
/// taken from the same folder inside the temporary worktree.
fn extract_map_at_commit(
    root: &Path,
    commit: &str,
    project_name: Option<&str>,
) -> Result<Option<FactMap>, DiffError> {
    let prefix = git(root, &["rev-parse", "--show-prefix"])?;
    let prefix = prefix.trim().trim_end_matches('/');
    let temporary = tempfile::Builder::new()
        .prefix("lightwell-map-")
        .tempdir()
        .map_err(|error| {
            DiffError::MapExtraction(format!("Could not reserve a temporary worktree: {error}"))
        })?;
    let worktree = temporary.path().join("worktree");
    let worktree_arg = path_for_git(&worktree);
    git(
        root,
        &["worktree", "add", "--detach", &worktree_arg, commit],
    )?;
    let workspace = if prefix.is_empty() {
        worktree.clone()
    } else {
        worktree.join(prefix)
    };
    let map = if workspace.is_dir() && project_manifest(&workspace).is_some() {
        extract_cargo_map(&workspace, project_name)
            .map(Some)
            .map_err(|error| DiffError::MapExtraction(map_extraction_message(&error)))
    } else {
        Ok(None)
    };
    let _ = git(root, &["worktree", "remove", "--force", &worktree_arg]);
    map
}

fn map_extraction_message(error: &MapExtractionError) -> String {
    error.to_string()
}

fn path_for_git(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn connection_key(connection: &Connection) -> (String, String, String, String) {
    match connection {
        Connection::Contains { source, target, .. } => (
            "contains".to_owned(),
            source.clone(),
            target.clone(),
            String::new(),
        ),
        Connection::DependsOn {
            source,
            target,
            dependency_scope,
            ..
        } => (
            "depends_on".to_owned(),
            source.clone(),
            target.clone(),
            dependency_scope_label(*dependency_scope),
        ),
    }
}

fn dependency_scope_label(scope: DependencyScope) -> String {
    match scope {
        DependencyScope::Normal => "normal".to_owned(),
        DependencyScope::Build => "build".to_owned(),
    }
}

fn diff_connections(before: &[Connection], after: &[Connection]) -> Vec<ConnectionChange> {
    let mut before_by_key: HashMap<(String, String, String, String), &Connection> = HashMap::new();
    for connection in before {
        before_by_key.insert(connection_key(connection), connection);
    }
    let mut after_by_key: HashMap<(String, String, String, String), &Connection> = HashMap::new();
    for connection in after {
        after_by_key.insert(connection_key(connection), connection);
    }
    let mut changes = Vec::new();
    for (key, connection) in &after_by_key {
        match before_by_key.get(key) {
            None => changes.push(connection_change(connection, "added")),
            Some(before_connection) if before_connection != connection => {
                changes.push(connection_change(connection, "changed"));
            }
            _ => {}
        }
    }
    for (key, connection) in &before_by_key {
        if !after_by_key.contains_key(key) {
            changes.push(connection_change(connection, "removed"));
        }
    }
    changes.sort_by(|left, right| left.id.cmp(&right.id));
    changes
}

fn connection_change(connection: &Connection, state: &str) -> ConnectionChange {
    match connection {
        Connection::Contains {
            id, source, target, ..
        } => ConnectionChange {
            id: id.clone(),
            source: source.clone(),
            target: target.clone(),
            kind: "contains".to_owned(),
            state: state.to_owned(),
        },
        Connection::DependsOn {
            id, source, target, ..
        } => ConnectionChange {
            id: id.clone(),
            source: source.clone(),
            target: target.clone(),
            kind: "depends_on".to_owned(),
            state: state.to_owned(),
        },
    }
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
    let output = command
        .output()
        .map_err(|_| DiffError::InvalidCommitRange {
            base: base.to_owned(),
            head: head.to_owned(),
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
    /// When present, reveal this line in the original file for a removed block.
    pub original_line: Option<usize>,
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
    let base_summary = base
        .filter(|value| !value.is_empty())
        .map(|base| resolve_commit(root, base))
        .transpose()?;
    if let Some(base) = &base_summary {
        ensure_ancestor(root, &base.id, &head_summary.id)?;
    }
    let before_commit = base_summary
        .as_ref()
        .map(|base| base.id.clone())
        .or_else(|| parent_commit(root, &head_summary.id));
    let after_map = extract_map_at_commit(root, &head_summary.id, Some(&map.project.name))?
        .unwrap_or_else(|| empty_map_like(map));
    let after_block = after_map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id);
    let before_map = if after_block.is_none() {
        match &before_commit {
            Some(commit) => extract_map_at_commit(root, commit, Some(&map.project.name))?,
            None => None,
        }
    } else {
        None
    };
    let block = after_block
        .or_else(|| {
            before_map.as_ref().and_then(|map| {
                map.blocks
                    .iter()
                    .find(|block| block_base(block).id == block_id)
            })
        })
        .ok_or_else(|| DiffError::BlockNotFound(block_id.to_owned()))?;
    let path = block_base(block)
        .source_path
        .as_deref()
        .ok_or_else(|| DiffError::BlockHasNoSource(block_id.to_owned()))?;
    let mut document = path_diff_for(root, &head_summary.id, base, path)?;
    let (_, hunks) = match &base_summary {
        Some(base) => revision_diff(root, &format!("{}..{}", base.id, head_summary.id))?,
        None => single_commit_diff(root, &head_summary.id)?,
    };
    let source = if after_block.is_some() {
        &document.modified
    } else {
        &document.original
    };
    let owning_map = if after_block.is_some() {
        Some(&after_map)
    } else {
        before_map.as_ref()
    };
    let parent_shares_file = block_base(block)
        .parent_id
        .as_ref()
        .and_then(|id| {
            owning_map?
                .blocks
                .iter()
                .find(|parent| block_base(parent).id == *id)
        })
        .is_some_and(|parent| block_base(parent).source_path == block_base(block).source_path);
    let spans = if parent_shares_file {
        symbol_spans(path, source)
    } else {
        HashMap::new()
    };
    let line = match span_for_block(&spans, block) {
        Some(&(start, end)) => hunks
            .get(&document.path)
            .into_iter()
            .flatten()
            .filter_map(|hunk| {
                let (first, count) = if after_block.is_some() {
                    (hunk.new_start, hunk.new_count)
                } else {
                    (hunk.old_start, hunk.old_count)
                };
                (count > 0 && first <= end && first + count > start).then_some(first.max(start))
            })
            .min()
            .unwrap_or(start),
        None => document.line,
    };
    if after_block.is_some() {
        document.line = line;
    } else {
        document.original_line = Some(line);
    }
    Ok(document)
}

/// Before and after text for a repository path across a commit or range.
pub fn path_diff_for(
    root: &Path,
    head: &str,
    base: Option<&str>,
    path: &str,
) -> Result<BlockDiffDocument, DiffError> {
    let head_summary = resolve_commit(root, head)?;
    let path = normalized(path);

    let (files, mut hunks) = match base.filter(|value| !value.is_empty()) {
        None => single_commit_diff(root, &head_summary.id)?,
        Some(base) => {
            let base_summary = resolve_commit(root, base)?;
            ensure_ancestor(root, &base_summary.id, &head_summary.id)?;
            revision_diff(root, &format!("{}..{}", base_summary.id, head_summary.id))?
        }
    };
    let file = files
        .into_iter()
        .find(|file| file.path == path || file.old_path.as_deref() == Some(&path))
        .ok_or_else(|| DiffError::FileUnchanged(path.clone()))?;
    let path = file.path.clone();
    let hunks = hunks.remove(&path).unwrap_or_default();
    let modified =
        git(root, &["show", &format!("{}:./{path}", head_summary.id)]).unwrap_or_default();
    let original_path = file.old_path.clone().unwrap_or_else(|| path.clone());
    let original = match base.filter(|value| !value.is_empty()) {
        None => git(
            root,
            &["show", &format!("{}^:./{original_path}", head_summary.id)],
        )
        .unwrap_or_default(),
        Some(base) => {
            let base_summary = resolve_commit(root, base)?;
            git(
                root,
                &["show", &format!("{}:./{original_path}", base_summary.id)],
            )
            .unwrap_or_default()
        }
    };

    let line = hunks
        .iter()
        .map(|hunk| hunk.new_start.max(1))
        .min()
        .unwrap_or(1);

    Ok(BlockDiffDocument {
        commit: head_summary,
        path,
        original_path: file.old_path,
        original,
        original_line: if modified.is_empty() {
            hunks.iter().map(|hunk| hunk.old_start.max(1)).min()
        } else {
            None
        },
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
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
}

/// Hunks per post-commit path from `-p -U0` output.
fn parse_hunks(patch: &str) -> HashMap<String, Vec<Hunk>> {
    let mut hunks: HashMap<String, Vec<Hunk>> = HashMap::new();
    let mut current: Option<String> = None;
    let mut old_path: Option<String> = None;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            current = None;
            old_path = None;
        } else if let Some(path) = line.strip_prefix("--- ") {
            old_path = path.strip_prefix("a/").map(str::to_owned);
        } else if let Some(path) = line.strip_prefix("+++ ") {
            current = path
                .strip_prefix("b/")
                .map(str::to_owned)
                .or_else(|| old_path.clone());
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
    let (old_start, old_count) = count(old)?;
    let (new_start, new_count) = count(new)?;
    Some(Hunk {
        old_start,
        old_count,
        new_start,
        new_count,
    })
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

fn attribute_changes(
    before: &FactMap,
    after: &FactMap,
    files: &[FileChange],
    hunks: &HashMap<String, Vec<Hunk>>,
    source_before: impl FnMut(&str) -> Option<String>,
    source_after: impl FnMut(&str) -> Option<String>,
) -> Vec<BlockChange> {
    let removed = attribute_side(before, files, hunks, source_before, false);
    let added = attribute_side(after, files, hunks, source_after, true);
    let before_ids: HashMap<_, _> = before
        .blocks
        .iter()
        .map(|block| (block_base(block).id.as_str(), block))
        .collect();
    let after_ids: HashMap<_, _> = after
        .blocks
        .iter()
        .map(|block| (block_base(block).id.as_str(), block))
        .collect();
    let removed_by_id: HashMap<_, _> = removed
        .iter()
        .map(|(index, count)| (block_base(&before.blocks[*index]).id.as_str(), *count))
        .collect();
    let mut changes = Vec::new();
    for (index, block) in after.blocks.iter().enumerate() {
        let base = block_base(block);
        let added = added.get(&index).copied().unwrap_or(0);
        let removed = removed_by_id.get(base.id.as_str()).copied().unwrap_or(0);
        if added + removed > 0 {
            changes.push(BlockChange {
                block_id: base.id.clone(),
                label: base.label.clone(),
                source_path: base.source_path.clone(),
                parent_id: base.parent_id.clone(),
                state: if before_ids.contains_key(base.id.as_str()) {
                    BlockChangeState::Changed
                } else {
                    BlockChangeState::Added
                },
                added,
                removed,
            });
        }
    }
    for (index, removed) in removed {
        let base = block_base(&before.blocks[index]);
        if !after_ids.contains_key(base.id.as_str()) {
            changes.push(BlockChange {
                block_id: base.id.clone(),
                label: base.label.clone(),
                source_path: base.source_path.clone(),
                parent_id: base.parent_id.clone(),
                state: BlockChangeState::Removed,
                added: 0,
                removed,
            });
        }
    }
    changes
}

/// Attribute one coordinate space only: added lines in the after file, or
/// removed lines in the before file. Symbols never inherit deletion anchors.
fn attribute_side(
    map: &FactMap,
    files: &[FileChange],
    hunks: &HashMap<String, Vec<Hunk>>,
    mut source_at_commit: impl FnMut(&str) -> Option<String>,
    after: bool,
) -> BTreeMap<usize, usize> {
    let by_id: HashMap<&str, &FactBlock> = map
        .blocks
        .iter()
        .map(|block| (block_base(block).id.as_str(), block))
        .collect();
    let path_of = |block: &FactBlock| block_base(block).source_path.as_deref().map(normalized);
    let mut counts = BTreeMap::new();
    for file in files {
        let path = if after {
            file.path.as_str()
        } else {
            file.old_path.as_deref().unwrap_or(&file.path)
        };
        let count = if after { file.added } else { file.removed };
        if count == 0 {
            continue;
        }
        let blocks: Vec<_> = map
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| path_of(block).as_deref() == Some(path))
            .collect();
        let mut symbols = Vec::new();
        for (index, block) in blocks {
            let is_symbol = block_base(block)
                .parent_id
                .as_deref()
                .and_then(|parent| by_id.get(parent))
                .is_some_and(|parent| path_of(parent) == path_of(block));
            if is_symbol {
                symbols.push((index, block));
            } else {
                *counts.entry(index).or_default() += count;
            }
        }
        if symbols.is_empty() {
            continue;
        }
        let Some(file_hunks) = hunks.get(&file.path) else {
            continue;
        };
        let Some(source) = source_at_commit(path) else {
            continue;
        };
        let spans = symbol_spans(path, &source);
        for (index, block) in symbols {
            let Some(&(start, end)) = span_for_block(&spans, block) else {
                continue;
            };
            let changed: usize = file_hunks
                .iter()
                .map(|hunk| {
                    let (first, count) = if after {
                        (hunk.new_start, hunk.new_count)
                    } else {
                        (hunk.old_start, hunk.old_count)
                    };
                    (first.max(start)..(first + count).min(end + 1)).len()
                })
                .sum();
            if changed > 0 {
                *counts.entry(index).or_default() += changed;
            }
        }
    }
    counts
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
    } else if lower.ends_with(".go") {
        parse_go_source(source)
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
    } else if lower.ends_with(".cs") {
        parse_csharp_source(source)
            .1
            .into_iter()
            .map(|symbol| (symbol.line, span_name(&symbol)))
            .collect()
    } else if lower.ends_with(".vb") {
        parse_vb_source(source)
            .1
            .into_iter()
            .map(|symbol| (symbol.line, span_name(&symbol)))
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

fn span_name(symbol: &crate::dotnet_source::DotnetSymbol) -> String {
    if symbol.kind == crate::dotnet_source::DotnetSymbolKind::Method {
        format!("{}@{}", symbol.name, symbol.line)
    } else {
        symbol.name.clone()
    }
}

fn span_for_block<'a>(
    spans: &'a HashMap<String, (usize, usize)>,
    block: &FactBlock,
) -> Option<&'a (usize, usize)> {
    let base = block_base(block);
    if base.id.contains(":method:") {
        if let Some(line) = base.id.rsplit(':').next() {
            if let Some(span) = spans.get(&format!("{}@{line}", base.label)) {
                return Some(span);
            }
        }
    }
    spans.get(base.label.as_str())
}

#[cfg(test)]
mod tests {
    use super::{
        block_diff, block_diff_for, commit_changes, commit_changes_for, parse_hunk_header,
        parse_numstat, path_diff_for, recent_commits, span_for_block, symbol_spans, DiffError,
        Hunk,
    };
    use crate::extract::{block_base, extract_cargo_map};
    use crate::facts::{FactBlock, FactMap};
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
    fn replaced_symbols_keep_their_own_added_and_removed_lines() {
        let root = temporary_directory("replaced-symbols");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"repro\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), "").unwrap();
        fs::write(
            root.join("scripts/job.py"),
            "def keep():\n    return 1\ndef retired():\n    return 3\n",
        )
        .unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Initial"]);
        fs::write(
            root.join("scripts/job.py"),
            "def keep():\n    return 1\ndef added():\n    return 4\n",
        )
        .unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Swap"]);
        let map = extract_cargo_map(&root, Some("repro")).unwrap();
        for base in [None, Some("HEAD^")] {
            let changes = commit_changes_for(&root, &map, "HEAD", base).unwrap();
            let counts: Vec<_> = changes
                .blocks
                .iter()
                .map(|block| (block.block_id.as_str(), block.added, block.removed))
                .collect();
            assert!(
                counts.contains(&("module:python:scripts-job-added:def", 2, 0)),
                "new symbol must not inherit removed lines: {counts:?}"
            );
            assert!(
                counts.contains(&("module:python:scripts-job-retired:def", 0, 2)),
                "deleted symbol must own its removed lines: {counts:?}"
            );
            assert!(!counts
                .iter()
                .any(|(id, _, _)| *id == "module:python:scripts-job-keep:def"));
            assert_eq!(
                changes
                    .files
                    .iter()
                    .map(|file| (file.path.as_str(), file.added, file.removed))
                    .collect::<Vec<_>>(),
                [("scripts/job.py", 2, 2)]
            );
            assert!(changes.connections.iter().any(|edge| edge.target
                == "module:python:scripts-job-retired:def"
                && edge.state == "removed"));
            let retired = changes
                .blocks
                .iter()
                .find(|block| block.block_id == "module:python:scripts-job-retired:def")
                .unwrap();
            assert_eq!(retired.state, super::BlockChangeState::Removed);
            assert_eq!(retired.label, "retired");
            assert_eq!(retired.source_path.as_deref(), Some("scripts/job.py"));
            assert_eq!(
                retired.parent_id.as_deref(),
                Some("module:python:scripts-job")
            );
            let document = block_diff_for(&root, &map, "HEAD", base, &retired.block_id).unwrap();
            assert_eq!(
                document.original,
                "def keep():\n    return 1\ndef retired():\n    return 3\n"
            );
            assert_eq!(
                document.modified,
                "def keep():\n    return 1\ndef added():\n    return 4\n"
            );
            assert_eq!(document.original_line, Some(3));
            let added = changes
                .blocks
                .iter()
                .find(|block| block.block_id == "module:python:scripts-job-added:def")
                .unwrap();
            assert_eq!(added.state, super::BlockChangeState::Added);
            let document = block_diff_for(&root, &map, "HEAD", base, &added.block_id).unwrap();
            assert_eq!(document.original_line, None);
            assert_eq!(document.line, 3);
        }
        fs::remove_file(root.join("scripts/job.py")).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Delete file"]);
        let current_map = extract_cargo_map(&root, Some("repro")).unwrap();
        let changes = commit_changes_for(&root, &current_map, "HEAD", None).unwrap();
        let counts: Vec<_> = changes
            .blocks
            .iter()
            .map(|block| {
                (
                    block.label.as_str(),
                    block.added,
                    block.removed,
                    block.state,
                )
            })
            .collect();
        assert_eq!(
            counts,
            [
                ("job", 0, 4, super::BlockChangeState::Removed),
                ("keep", 0, 2, super::BlockChangeState::Removed),
                ("added", 0, 2, super::BlockChangeState::Removed),
            ]
        );
        let document = block_diff_for(
            &root,
            &current_map,
            "HEAD",
            None,
            "module:python:scripts-job-added:def",
        )
        .unwrap();
        assert_eq!(
            document.original,
            "def keep():\n    return 1\ndef added():\n    return 4\n"
        );
        assert_eq!(document.modified, "");
        assert_eq!(document.original_line, Some(3));
        let historical = commit_changes_for(&root, &current_map, "HEAD^", Some("HEAD^^")).unwrap();
        assert!(historical
            .blocks
            .iter()
            .any(|block| block.label == "added" && block.added == 2 && block.removed == 0));
        let document = block_diff_for(
            &root,
            &current_map,
            "HEAD^",
            Some("HEAD^^"),
            "module:python:scripts-job-retired:def",
        )
        .unwrap();
        assert_eq!(document.original_line, Some(3));
        assert_eq!(
            document.modified,
            "def keep():\n    return 1\ndef added():\n    return 4\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn connection_diff_reports_added_and_removed_edges() {
        use crate::facts::Connection;
        let before = vec![Connection::Contains {
            id: "contains:workspace->crate:a".into(),
            source: "workspace".into(),
            target: "crate:a".into(),
        }];
        let after = vec![
            Connection::Contains {
                id: "contains:workspace->crate:a".into(),
                source: "workspace".into(),
                target: "crate:a".into(),
            },
            Connection::Contains {
                id: "contains:crate:a->module:b".into(),
                source: "crate:a".into(),
                target: "module:b".into(),
            },
        ];
        let changes = super::diff_connections(&before, &after);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].state, "added");
        assert_eq!(changes[0].id, "contains:crate:a->module:b");
        let removed = super::diff_connections(&after, &before);
        assert_eq!(removed[0].state, "removed");
    }

    #[test]
    fn hunk_headers_default_counts_to_one() {
        assert_eq!(
            parse_hunk_header("3,2 +4 @@ fn x"),
            Some(Hunk {
                old_start: 3,
                old_count: 2,
                new_start: 4,
                new_count: 1
            })
        );
        assert_eq!(
            parse_hunk_header("10 +9,0 @@"),
            Some(Hunk {
                old_start: 10,
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
    fn each_overload_keeps_its_own_span() {
        let source = include_str!("../fixtures/dotnet-sample/csharp/Overloads.cs");
        let spans = symbol_spans("Overloads.cs", source);
        assert_ne!(
            spans.get("Choose@4"),
            spans.get("Choose@9"),
            "overloads must not share the first span: {spans:?}"
        );
        assert_eq!(spans.get("Choose@4").map(|span| span.0), Some(4));
        assert_eq!(spans.get("Choose@9").map(|span| span.0), Some(9));
        let first = span_for_block(&spans, &method_block(4)).copied();
        let second = span_for_block(&spans, &method_block(9)).copied();
        assert_eq!(first.map(|span| span.0), Some(4));
        assert_eq!(second.map(|span| span.0), Some(9));
        assert_ne!(first, second);
    }

    fn method_block(line: usize) -> FactBlock {
        FactBlock::Module(crate::facts::ModuleBlock {
            base: crate::facts::BlockBase {
                id: format!("module:dotnet:method:app-overloads:choose:{line}"),
                label: "Choose".to_owned(),
                parent_id: None,
                children: Vec::new(),
                source_path: Some("Overloads.cs".to_owned()),
                fingerprint: String::new(),
            },
            package_name: "App".to_owned(),
            module_path: "App.Overloads.Choose".to_owned(),
            declared_by_path: "Overloads.cs".to_owned(),
            cfg_attributes: vec!["method".to_owned()],
            unresolved: false,
            language: "csharp".to_owned(),
        })
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
    fn concurrent_commit_maps_keep_repository_contents_and_clean_up_their_worktrees() {
        let fixtures = tempfile::tempdir().unwrap();
        let roots = [fixtures.path().join("alpha"), fixtures.path().join("beta")];
        for (root, module) in roots.iter().zip(["alpha", "beta"]) {
            fs::create_dir_all(root.join("src")).unwrap();
            fs::write(
                root.join("Cargo.toml"),
                r#"[package]
name = "parallel-fixture"
version = "0.1.0"
edition = "2021"
"#,
            )
            .unwrap();
            fs::write(root.join("src/lib.rs"), format!("pub mod {module};\n")).unwrap();
            fs::write(root.join(format!("src/{module}.rs")), "pub fn owned() {}\n").unwrap();
            git(root, &["init", "-q"]);
            git(root, &["add", "."]);
            git(root, &["commit", "-q", "-m", "Initial"]);
        }
        let barrier = std::sync::Barrier::new(2);
        let changes = std::thread::scope(|scope| {
            let handles: Vec<_> = roots
                .iter()
                .map(|root| {
                    let barrier = &barrier;
                    scope.spawn(move || {
                        let map = extract_cargo_map(root, None).unwrap();
                        barrier.wait();
                        commit_changes(root, &map, "HEAD").unwrap()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        for ((root, changes), (owned, other, expected_files)) in roots.iter().zip(changes).zip([
            (
                "alpha",
                "beta",
                ["Cargo.toml", "src/alpha.rs", "src/lib.rs"],
            ),
            ("beta", "alpha", ["Cargo.toml", "src/beta.rs", "src/lib.rs"]),
        ]) {
            assert_eq!(changes.commit.summary, "Initial");
            let mut files = changes
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>();
            files.sort_unstable();
            assert_eq!(files, expected_files);
            let modules = changes
                .blocks
                .iter()
                .map(|block| block.label.as_str())
                .collect::<Vec<_>>();
            assert!(
                modules.contains(&owned),
                "{owned} should remain in its own map: {modules:?}"
            );
            assert!(
                !modules.contains(&other),
                "{other} belongs to the other repository: {modules:?}"
            );
            assert_eq!(
                fs::read_to_string(root.join("src/lib.rs")).unwrap(),
                format!("pub mod {owned};\n")
            );
            let worktrees = super::git(root, &["worktree", "list", "--porcelain"]).unwrap();
            assert_eq!(
                worktrees
                    .lines()
                    .filter(|line| line.starts_with("worktree "))
                    .count(),
                1,
                "temporary worktrees must be removed: {worktrees}"
            );
            let registrations = root.join(".git/worktrees");
            assert!(
                !registrations.exists() || fs::read_dir(registrations).unwrap().next().is_none()
            );
        }
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
        assert_eq!(
            ranged.base_commit.as_ref().map(|c| c.summary.as_str()),
            Some("Initial")
        );
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

        let range_diff = block_diff_for(
            &root,
            &map,
            &commits[0].id,
            Some(&commits[2].id),
            &id_of("plan"),
        )
        .unwrap();
        assert!(range_diff.original.contains("    return 1\n"));
        assert!(range_diff.modified.contains("    return 99\n"));

        assert!(matches!(
            commit_changes_for(&root, &map, &commits[0].id, Some(&commits[0].id)),
            Err(DiffError::InvalidCommitRange { .. })
        ));

        fs::remove_dir_all(root).unwrap();
    }

    fn module_id_ending(map: &FactMap, suffix: &str) -> String {
        map.blocks
            .iter()
            .find(|block| {
                matches!(block, FactBlock::Module(_))
                    && block_base(block)
                        .source_path
                        .as_deref()
                        .is_some_and(|path| path.ends_with(suffix))
            })
            .map(|block| block_base(block).id.clone())
            .unwrap_or_else(|| panic!("{suffix} should have a module block"))
    }

    #[test]
    fn commit_diff_maps_a_nested_crate_in_a_repo_without_a_root_manifest() {
        let repo = temporary_directory("nested crate diff");
        let root = repo.join("tools/my crate");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(repo.join("README.md"), "docs\n").unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"nested\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(root.join("src/lib.rs"), "pub mod old_name;\n").unwrap();
        fs::write(root.join("src/old_name.rs"), "pub fn value() -> u8 { 1 }\n").unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "Initial"]);
        fs::write(root.join("src/lib.rs"), "pub mod new_name;\n").unwrap();
        git(
            &repo,
            &[
                "mv",
                "tools/my crate/src/old_name.rs",
                "tools/my crate/src/new_name.rs",
            ],
        );
        fs::write(root.join("src/new_name.rs"), "pub fn value() -> u8 { 2 }\n").unwrap();
        fs::write(root.join("logo.bin"), [0_u8, 159, 146, 150, 0, 1]).unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "Rename and change"]);
        fs::write(root.join("scratch.rs"), "untracked\n").unwrap();

        let map = extract_cargo_map(&root, None).expect("the nested crate should map");
        let head = recent_commits(&root, 5).unwrap()[0].id.clone();
        let changes = commit_changes(&root, &map, &head)
            .unwrap_or_else(|error| panic!("commit diff should not need a root manifest: {error}"));
        assert!(changes
            .files
            .iter()
            .any(|file| file.path.ends_with("new_name.rs")));
        let file = path_diff_for(&root, &head, None, "src/new_name.rs").expect("file diff");
        assert!(file.modified.contains("2"));
        let block = block_diff(&root, &map, &head, &module_id_ending(&map, "new_name.rs"))
            .expect("block diff");
        assert!(block.modified.contains("2"));
        assert!(path_diff_for(&root, &head, None, "logo.bin").is_ok());
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn commit_diff_treats_a_commit_before_the_project_existed_as_empty() {
        let root = temporary_directory("late manifest diff");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "docs\n").unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Docs only"]);
        fs::write(root.join("package.json"), "{\n  \"name\": \"web\"\n}\n").unwrap();
        fs::write(root.join("index.js"), "export const value = 1;\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "Add the app"]);

        let map = extract_cargo_map(&root, None).expect("a Node project should map");
        let commits = recent_commits(&root, 5).unwrap();
        let changes = commit_changes(&root, &map, &commits[0].id)
            .unwrap_or_else(|error| panic!("parent without a manifest should diff: {error}"));
        assert!(changes.files.iter().any(|file| file.path == "index.js"));
        let range = commit_changes_for(&root, &map, &commits[0].id, Some(&commits[1].id))
            .expect("range from a commit without a manifest should diff");
        assert!(range.files.iter().any(|file| file.path == "index.js"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_repo_without_commits_reports_an_invalid_commit_not_a_map_error() {
        let root = temporary_directory("empty repo diff");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("package.json"), "{\n  \"name\": \"web\"\n}\n").unwrap();
        git(&root, &["init", "-q"]);
        let map = extract_cargo_map(&root, None).expect("a Node project should map");
        let error = commit_changes(&root, &map, "HEAD")
            .expect_err("a repository without commits has no HEAD to diff");
        assert!(matches!(error, DiffError::InvalidCommit(_)), "{error}");
        fs::remove_dir_all(root).unwrap();
    }
}
