# Changelog

## 0.1.7 - 2026-10-15

### Fixed

- The Windows app opens to Lightwell instead of a `localhost refused to connect` page. The Windows build now embeds the viewer.
- The macOS disk image is named `Lightwell_<version>_aarch64.dmg`, so every release download carries the version number.

## 0.1.6 - 2026-10-14

### Fixed

- The Windows installer is named `Lightwell_<version>_x64.msi`, like the other release assets. The release-text check rejected the old name, so 0.1.5 was not published.

## 0.1.5 - 2026-10-14 (not published)

### Fixed

- A Node or TypeScript project with no Cargo.toml now opens.
- On Windows, source files open with the system shell handler.

### Changed

- The test suite now runs on Windows in CI.

## 0.1.4 - 2026-10-13

### Added

- TypeScript, JavaScript, HTML, and CSS support in the map and source inspector.
- React and Next.js project detection.
- Python support.
- Rust ships as a built-in language pack.
- Project notes are on by default, with right-click note menus on map blocks. `VITE_ENABLE_PROJECT_NOTES=false` omits the notes commands from the bundle.
- Saving preferences now shows confirmation feedback.

### Changed

- Blueprint is now the default theme for new installs and unset preferences. A saved theme choice (including Follow system) is kept.
- Blueprint is redesigned: stepped navy surfaces, a two-level map grid, tinted status and kind colours, an amber focus and selection ring, and syntax colours in the source inspector. Every text role meets WCAG AA.
- The app window starts in Blueprint navy, so launch no longer flashes the old dark background.

### Fixed

- The app icon now displays correctly.

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
