# Changelog

## 0.1.0 - 2026-10-11

First public source release. Version 0.1.0 is the version in `Cargo.toml` and `package.json`.

### Added

- A browser viewer for Rust workspaces: crates, app targets, Rust modules, Cargo features, dependency edges, and written notes.
- Checked-in Prismattyc and Scorecard preview maps that load without a network request.
- A desktop shell for opening a local Cargo workspace. Project notes in that shell stay off unless `VITE_ENABLE_PROJECT_NOTES` is set.
- CLI commands `extract`, `watch`, `open`, and `notes`.
- macOS builds with a minimum system version of 11.0, and Linux CLI builds with a glibc 2.28 floor.
- An app icon, the MPL-2.0 license, and a third-party license inventory.

### Privacy

Maps, project notes, recent workspaces, and editor settings stay on your machine. See [PRIVACY.md](PRIVACY.md).
