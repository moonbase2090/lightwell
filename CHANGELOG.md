# Changelog

## Unreleased

### Added

- The vertical file tree zooms from **−**, the percentage (reset), and **+**, or with Ctrl/Cmd +, Ctrl/Cmd −, and Ctrl/Cmd 0. The level is saved per workspace.

### Fixed

- The vertical file tree places each row's path and child count beside the name. The path column has a bounded width.
- A C# namespace whose opening brace is on the next line stays block-scoped, so a later sibling type is not pulled into it. Method overloads keep separate commit-diff spans. C# and VB.NET type names keep non-ASCII characters.

## 0.1.14 - 2026-10-18

### Added

- C# and VB.NET map extraction. A solution or project defines the project boundary. Namespaces, source files, types (including partial types), and methods become blocks. Project references, imports, and resolved type names become connections. `bin/` and `obj/` are skipped. Both languages are highlighted in the source view. Support is on by default (#138).
- Go language pack: `go.mod` workspaces map packages, `.go` files, import edges, and top-level functions, methods, and types, with Monaco highlighting and commit-diff symbol spans for `.go` files (#137, #139).
- Tauri updater signing for release builds: a production public key in the app, signed `latest.json` on tagged releases, and a hard failure when the signing secret is absent in the release workflow (#140).

### Changed

- Release publishing now requires `TAURI_SIGNING_PRIVATE_KEY` in GitHub Actions secrets so `latest.json` is always signed for shipped tags (#140).

### Fixed

- README and release notes use **Collapse** (not “Collapse all”) for the Files explorer control, and document that **Depth** applies in Files view as well as Modules (#141).
- Go extraction no longer panics on non-ASCII source before `import` lines; block comments keep newlines so symbol line numbers stay aligned. The TypeScript Go mirror now emits the same qualified-call `depends_on` edges as Rust (#139).

## 0.1.13 - 2026-10-17

### Added

- In **Files** mode, an explorer-style vertical file tree with a filter box, **Expand all** and **Collapse**, kind badges and short paths on each row, and an inspector that shows the selected file or folder and its children. A rotate control on the map toolbar switches back to the horizontal graph; the choice is saved per workspace and vertical is the default (#129, #130).
- A commit diff view on the map toolbar: pick **Through** and optional **Since** commits to see which blocks changed and which connections were added, removed, or changed. Changed blocks show line counts; inspecting a changed block opens a side-by-side diff (#132, #133, #134).
- In-app update checks, on by default. When a newer release is available, Lightwell shows the release notes and download links; Settings can turn checks off or run **Check now** (#131). One-click install is not available until an updater signing key is configured for the build.
- A larger Settings dialog for editor and update preferences (#128).

### Changed

- The commit diff view is on in default desktop builds. Set `VITE_ENABLE_COMMIT_DIFF=false` when building to omit history commands.
- Contributors can install an optional pre-commit hook that runs `rustfmt --check` on staged Rust files (`scripts/install-hooks.sh`) (#135).

## 0.1.12 - 2026-10-15

### Added

- A Modules / Files toggle on the workspace map. Files groups the mapped blocks into repository folders as a file tree. The choice is saved per workspace and defaults to Modules (#125).
- A Depth control on the workspace map in Modules and Files views, from 1 to the depth of the current tree, or All. The default stays 2, and the choice is saved per workspace (#120).
- Project notes show with their block: a project note card in the details panel and source inspector, a note preview on the map card badge, and **Show on map** in the notes dialog.
- A word wrap toggle in the source view, from the source line context menu or **Alt+Z**. The choice is kept and defaults to off.

### Changed

- Opening a block's source resolves it against the map the workspace watcher keeps, instead of extracting the whole workspace again on every click.
- Blocks with no annotation show no status chip.
- Search and **Show on map** center and zoom on the block.
- The source view remeasures fonts once they load, so text is no longer drawn under the line-number gutter.

## 0.1.11 - 2026-10-15

The 0.1.9 and 0.1.10 tags were not published. 0.1.11 carries their changes.

### Changed

- The rpm and Linux tarballs are named `Lightwell_<version>_x86_64.rpm` and `Lightwell_<version>_linux_<arch>.tar.gz`, and the tarballs unpack to `lightwell/`.
- The release text check scans release text, asset names and text assets such as `SHA256SUMS`, not the contents of binaries. `--deep` keeps the full scan.

## 0.1.10 - 2026-10-15 (not published)

The 0.1.9 tag was not published: its Linux bundle smoke could not find the
AppImage. 0.1.10 carries the 0.1.9 changes below.

### Fixed

- The release workflow passes the Linux bundle smoke an absolute path.

## 0.1.9 - 2026-10-15 (not published)

### Added

- A universal macOS disk image, `Lightwell_<version>_universal.dmg`, for Intel and Apple Silicon Macs. It is signed and notarized like the Apple Silicon image.
- Linux builds for distributions beyond Debian and Ubuntu: `Lightwell_<version>_amd64.AppImage`, `Lightwell-<version>-1.x86_64.rpm` for Fedora, RHEL and openSUSE, and a portable `lightwell-<version>-linux-x86_64.tar.gz` with the command line tool, the desktop app and an `install.sh`. `packaging/arch/PKGBUILD` builds an Arch package from the tarball.
- `lightwell-<version>-linux-aarch64.tar.gz` with the command line tool for Linux on ARM.
- `lightwell --version`.

### Changed

- CI launches the AppImage headless, unpacks the rpm and deb, installs the tarball, and checks that every desktop binary embeds the viewer instead of loading a dev server.

## 0.1.8 - 2026-10-15

### Fixed

- Clicking a module on macOS no longer turns the window blank. The source inspector no longer loads a Node built-in in the viewer.
- Live refresh works for projects without a root `Cargo.toml`, such as TypeScript, JavaScript and Python projects. It no longer reports `No Cargo.toml found`.
- The Windows desktop viewer no longer crashes, source files open in the configured editor, and console windows no longer flash or freeze the app.
- The first map is fitted after its layout finishes, so it is in view when a project opens.

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
