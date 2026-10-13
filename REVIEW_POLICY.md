# Review policy

This policy applies to every pull request, whether a person or an agent wrote it.

## 1. Classify every PR

**Trunk**: the change touches shared code that other parts depend on:
- core libraries and shared modules
- auth, secrets, and permissions
- data models, schemas, and migrations
- CI, release, and signing workflows; build configuration
- public APIs, CLI flags, config formats
- anything with 5 or more dependents

**Leaf**: everything else, such as a single UI screen, docs, a self-contained script, or test-only changes.

A PR that is partly trunk is trunk. When unsure, call it trunk. Label trunk PRs `trunk` and leaf PRs `leaf`.

In Lightwell, trunk includes:
- `crates/lightwell-core/`, its public API in `crates/lightwell-core/src/lib.rs`, and every shared Rust model or extractor used by the CLI and Tauri app.
- The schema-v1 map data model: `crates/lightwell-core/src/facts.rs`, `src/schema.ts`, `docs/schema.md`, and checked-in `maps/*.facts.json` and `maps/*.annotations.json`.
- The project-notes format in `crates/lightwell-core/src/notes.rs`, including `.lightwell/notes.json`.
- Shared viewer modules such as `src/map-source.ts`, `src/model.ts`, and `src/theme.ts`.
- The Tauri boundary: commands in `crates/lightwell-app/src/main.rs` and `crates/lightwell-app/src/workspace.rs`, `src/map-sources/tauri.ts`, `src/map-sources/tauri-types.ts`, `crates/lightwell-app/tauri.conf.json`, and `crates/lightwell-app/capabilities/default.json`.
- The CLI surface: `crates/lightwell-cli/`, `src/cli.ts`, and `bin/lightwell.mjs`.
- CI, release, and signing files under `.github/workflows/` and `scripts/ci/`.
- Build and analysis configuration: `Cargo.toml`, `Cargo.lock`, `crates/*/Cargo.toml`, `crates/lightwell-app/build.rs`, `package.json`, `package-lock.json`, `tsconfig.json`, and `analyzer.toml`.

Leaf examples include one panel such as `src/EditorSettingsPanel.tsx`, `src/SourceInspectorPanel.tsx`, `src/ProjectNotesDialog.tsx`, `src/Splitter.tsx`, or `src/viewer/BlockNode.tsx`; documentation under `docs/plan/` or `docs/proof/`; one `scripts/ci/capture-*.sh` script; or test-only changes.

## 2. Proof

The PR body has a **Proof** section with real evidence: test output, a CI run link, a screenshot or recording for UI changes, or a before/after for behavior changes. "Tested locally" without output is not proof.

## 3. Leaf PRs

- CI green and proof present.
- One review by anyone other than the author.
- Merge once green.

## 4. Trunk PRs

- CI green, and the proof shows the change running, not just compiling.
- Agentic validation: an agent other than the author builds and exercises the change.
- Independent review, preferably by a different model than the author.
- Every finding is fixed or explicitly waived in the PR thread.
- Then merge.

## 5. Feature gating

New behavior in trunk code ships behind a flag or setting that is off by default, unless it is a pure fix. Turning a flag on by default is its own trunk PR.

For example, the Project notes dialog is gated by `VITE_ENABLE_PROJECT_NOTES` and remains off in default builds.

Language-pack extraction and inspector highlighting are the exception. When a pack implements them, they ship on in the pull request that adds the pack. They are not gated off by default, and they do not need a second pull request to enable them.

## 6. Tests

For every test, ask: would it fail if the behavior it names broke? If not, reject it. Reject tests that:

- assert a value against itself, or a constant against the same constant
- compute the expected value with the code under test or a copy of its logic
- mock or stub the unit under test, then assert what the mock returns
- only check that something ran, was called, or didn't panic, with no assertion on the result
- compare against a snapshot or golden file regenerated from current output without review
- still pass when the implementation is deleted or replaced with a stub or default

Review rejects tests like these. See the Tests section of `AGENTS.md`.

## 7. Merging

- Merge commits only. No admin overrides.
- Code-scanning threads are resolved only when they are report-only or addressed, never just to unblock a merge.
- Releases and tags need owner approval.

## 8. Release text

Release text and artifacts must not reference private infrastructure, hostnames, personal paths, or internal tooling.

## Review exceptions

These rules narrow when a fresh review is needed. They replace nothing above unless they say so.

- **Docs-only and changelog-only PRs** may merge on green checks plus the release-text check, with no review. A PR qualifies only if every changed file is documentation or the changelog; any code, config, CI, or workflow change makes it a normal PR.
- **A SHIP carries over** a clean rebase or a label-only change, as long as the PR's own diff is unchanged. Compare the old and new tips with `git range-diff` or the patch-id (`git diff <base>...<tip> | git patch-id --stable`). If the diff changed at all, the PR needs a new review at the new tip.
- **Leaf Windows fixes** merge on a code SHIP and green CI. Windows runtime proof for them is batched and recorded before each release instead of blocking each PR.
- **Still need a full cross-family review at the exact tip**: security and red-team fixes, trunk PRs, CI and workflow changes, release PRs, and public-API changes. The reviewer is a different model family than the author, and the review names the tip SHA.
