# Changelog

## 0.1.3 - 2026-10-12

### Fixed

- The release-text check no longer fails on the DMG's Applications shortcut.

## 0.1.2 - 2026-10-12 (not published)

### Changed

- Lightwell is now licensed under the MIT license, copyright Moonbase 2090 LLC.
- The release-text check also scans DMG artifacts.

## 0.1.1 - 2026-10-11 (not published)

### Changed

- macOS releases ship as a signed, notarized drag-to-Applications DMG.
- GitHub release notes are built from the annotated tag message without OpenSSH or PGP signature blocks.

## 0.1.0 - 2026-10-11

First public source release. Version 0.1.0 is the version in `Cargo.toml` and `package.json`.

### Added

- A browser viewer for Rust workspaces: crates, app targets, Rust modules, Cargo features, dependency edges, and written notes.
- Checked-in Prismattyc and Scorecard preview maps that load without a network request.
- A desktop shell for opening a local Cargo workspace. Project notes in that shell stay off unless `VITE_ENABLE_PROJECT_NOTES` is set.
- CLI commands `extract`, `watch`, `open`, and `notes`.
- macOS builds with a minimum system version of 11.0, and Linux CLI builds with a glibc 2.28 floor.
- An app icon, the MIT license, and a third-party license inventory.

### Privacy

Maps, project notes, recent workspaces, and editor settings stay on your machine. See [PRIVACY.md](PRIVACY.md).
