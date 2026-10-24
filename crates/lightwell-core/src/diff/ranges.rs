use super::{ensure_ancestor, git, resolve_commit, CommitSummary};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommitRangePreset {
    LastCommit,
    LastFive,
    SinceRelease,
    Custom { from: Option<String> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCommitRange {
    pub commit: CommitSummary,
    pub base_commit: Option<CommitSummary>,
    pub commit_count: usize,
    pub release_tag: Option<String>,
}

/// Resolve display metadata without extracting maps or changing diff semantics.
pub fn resolve_commit_range(
    root: &Path,
    through: &str,
    preset: CommitRangePreset,
) -> Result<ResolvedCommitRange, String> {
    let commit = resolve_commit(root, through).map_err(|e| e.to_string())?;
    let exact_five = matches!(&preset, CommitRangePreset::LastFive);
    let mut release_tag = None;
    let from = match preset {
        CommitRangePreset::LastCommit => None,
        CommitRangePreset::Custom { from } => from,
        CommitRangePreset::LastFive => {
            let history = git(
                root,
                &["rev-list", "--first-parent", "--max-count=6", &commit.id],
            )
            .map_err(|e| e.to_string())?;
            let ids: Vec<_> = history.lines().collect();
            let Some(base) = ids.get(5) else {
                return Err(format!("Last 5 commits needs an older base commit. This history has only {} mainline {}; choose Last commit or Custom.", ids.len(), if ids.len() == 1 { "commit" } else { "commits" }));
            };
            Some((*base).to_owned())
        }
        CommitRangePreset::SinceRelease => {
            let tag = git(
                root,
                &[
                    "describe",
                    "--tags",
                    "--abbrev=0",
                    "--match",
                    "v[0-9]*",
                    "--match",
                    "[0-9]*",
                    &commit.id,
                ],
            )
            .map_err(|_| {
                "No reachable version tag for this history. Choose Last commit or Custom."
                    .to_owned()
            })?;
            let tag = tag.trim_end().to_owned();
            let base =
                resolve_commit(root, &format!("refs/tags/{tag}")).map_err(|e| e.to_string())?;
            release_tag = Some(tag);
            Some(base.id)
        }
    };
    let base_commit = from
        .as_deref()
        .map(|id| resolve_commit(root, id).map_err(|e| e.to_string()))
        .transpose()?;
    let commit_count = if let Some(base) = &base_commit {
        if base.id == commit.id && release_tag.is_some() {
            0
        } else {
            ensure_ancestor(root, &base.id, &commit.id).map_err(|_| {
                "From must be an older ancestor of To. Choose a valid range.".to_owned()
            })?;
            git(
                root,
                &[
                    "rev-list",
                    "--count",
                    &format!("{}..{}", base.id, commit.id),
                ],
            )
            .map_err(|e| e.to_string())?
            .trim()
            .parse::<usize>()
            .map_err(|_| "Git returned an invalid commit count.".to_owned())?
        }
    } else {
        1
    };
    if exact_five && commit_count != 5 {
        return Err(format!("This five-step mainline range includes {commit_count} commits through merged history. Choose Custom to select its endpoints explicitly."));
    }
    Ok(ResolvedCommitRange {
        commit,
        base_commit,
        commit_count,
        release_tag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "lightwell-range-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let repo = Self(root);
            repo.run(&["init", "-q", "-b", "main"]);
            repo.run(&["config", "maintenance.auto", "false"]);
            repo.run(&["config", "gc.auto", "0"]);
            repo
        }
        fn run(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args([
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "tag.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        }
        fn commit(&self, label: &str) -> String {
            self.run(&["commit", "--allow-empty", "-qm", label]);
            self.run(&["rev-parse", "HEAD"])
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn presets_count_actual_range_and_keep_the_base_excluded() {
        let repo = Repo::new();
        let base = repo.commit("Root");
        repo.run(&["tag", "-a", "v1.0.0", "-m", "Release"]);
        for i in 1..=5 {
            repo.commit(&format!("Change {i}"));
        }
        let range = resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::LastFive).unwrap();
        assert_eq!(range.commit_count, 5);
        assert_eq!(range.base_commit.unwrap().id, base);
        assert_eq!(range.commit.summary, "Change 5");
        let release =
            resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::SinceRelease).unwrap();
        assert_eq!(release.commit_count, 5);
        assert_eq!(release.release_tag.as_deref(), Some("v1.0.0"));
        assert_eq!(release.base_commit.unwrap().id, base);
        let single = resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::LastCommit).unwrap();
        assert_eq!(single.commit_count, 1);
        assert!(single.base_commit.is_none());
    }

    #[test]
    fn root_missing_tags_empty_release_and_invalid_ranges_are_explicit() {
        let repo = Repo::new();
        let root = repo.commit("Root");
        assert_eq!(
            resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::LastCommit)
                .unwrap()
                .commit_count,
            1
        );
        assert!(
            resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::LastFive)
                .unwrap_err()
                .contains("only 1")
        );
        assert!(
            resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::SinceRelease)
                .unwrap_err()
                .contains("No reachable")
        );
        repo.run(&["tag", "v1.0.0"]);
        let empty = resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::SinceRelease).unwrap();
        assert_eq!(empty.commit_count, 0);
        assert_eq!(empty.base_commit.unwrap().id, root);
        assert!(resolve_commit_range(
            &repo.0,
            "HEAD",
            CommitRangePreset::Custom { from: Some(root) }
        )
        .unwrap_err()
        .contains("older ancestor"));
        assert!(resolve_commit_range(&repo.0, "--help", CommitRangePreset::LastCommit).is_err());
    }

    #[test]
    fn unreachable_release_is_ignored_and_merge_ranges_are_not_miscounted() {
        let repo = Repo::new();
        let root = repo.commit("Root");
        repo.run(&["tag", "v1.0.0"]);
        repo.run(&["checkout", "-qb", "side"]);
        repo.commit("Side change");
        repo.run(&["tag", "v9.0.0"]);
        repo.run(&["checkout", "-q", "main"]);
        for i in 1..=4 {
            repo.commit(&format!("Main {i}"));
        }
        let release =
            resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::SinceRelease).unwrap();
        assert_eq!(release.release_tag.as_deref(), Some("v1.0.0"));
        assert_eq!(release.commit_count, 4);
        repo.run(&["merge", "--no-ff", "-qm", "Merge side", "side"]);
        assert!(
            resolve_commit_range(&repo.0, "HEAD", CommitRangePreset::LastFive)
                .unwrap_err()
                .contains("includes 6")
        );
        let custom = resolve_commit_range(
            &repo.0,
            "HEAD",
            CommitRangePreset::Custom { from: Some(root) },
        )
        .unwrap();
        assert_eq!(custom.commit_count, 6);
        assert_eq!(custom.commit.summary, "Merge side");
    }
}
