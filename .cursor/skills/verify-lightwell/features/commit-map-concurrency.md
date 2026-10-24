# Concurrent commit maps

Run this check when changing commit-diff extraction or temporary worktree allocation.

```sh
cargo test -p lightwell-core --lib --locked concurrent_commit_maps_keep_repository_contents_and_clean_up_their_worktrees -- --nocapture
cargo test -p lightwell-core --lib --locked
```

The focused regression creates separate alpha and beta repositories, then calls the public `commit_changes` API concurrently. It requires each result to contain its own module and literal file paths, exclude the other repository's module, preserve the original sources, and leave only the original worktree with no temporary administrative registrations. Both commands must exit zero. Keep parallel test execution enabled.

For a runtime release fix, also run the check from freshly unpacked source with a fresh Cargo target directory in a clean macOS VM. Retain the source revision and hashes, build/test logs, and host-captured terminal results. A prior binary or another revision does not cover the fix.
