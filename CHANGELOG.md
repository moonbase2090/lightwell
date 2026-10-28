# Changelog

## Unreleased

### Added

<<<<<<< HEAD
- `lightwell notes for-file <path>` lists notes for a source file and marks stale fingerprints (#200).
=======
- `lightwell notes list` and `notes set` accept `--map` to reuse a precomputed workspace map (#201).
>>>>>>> origin/main

### Fixed

- Human-readable `lightwell notes list` output shows `unknown` for legacy notes without an update timestamp (#204).

## 0.1.22 - 2026-10-28

### Changed

- The Windows release build registers the PowerShell Gallery before signing, so the signing step can install its module again (#214).

## 0.1.21 - 2026-10-27

### Added

- Swift projects map SwiftPM packages (`Package.swift`) and Xcode projects (`*.xcodeproj`), with modules, files, types, functions, and imports, and Swift source highlighting (#189).

## 0.1.20 - 2026-10-27

### Added

- Configuration and infrastructure projects map YAML services and resources, Terraform declarations, and Dockerfile stages with deployment wiring (#193).
- Java and Kotlin projects map Maven and Gradle modules, packages, classes, and imports (#191).
- Project notes can be marked reviewed without changing their text, and stale notes can be removed in bulk behind opt-in controls (#185).
- The workspace map can open in an opt-in fullscreen-capable pop-out window (#196).

### Changed

- `lightwell notes set` requires `--replace` to overwrite an existing note (#198).

## 0.1.19 - 2026-10-26

### Added

- CMake-based C and C++ projects map targets, source and header files, top-level symbols, and quoted include edges (#195).
- PHP and Ruby projects map Composer or Gemfile packages, namespaces and modules, classes, and import or require edges (#194).
- Project notes record an author and last-updated timestamp, with defaults for legacy notes (#197).
- Notes CLI commands accept `-C` or `--repo <path>` to target a workspace from any current directory (#186).

### Changed

- Commit changes has named range presets and a custom chronological range (#190).
- Notes documentation explains that saving a note does not stage it and shows the required `git add` command (#188).
- Vite is updated to 8.3.3 (#202).

### Fixed

- Failed temporary Git worktree removal clears only the matching checkout and administrative registration (#187).

## 0.1.18 - 2026-10-23

### Added

- Project-notes CLI commands accept `--json`, with documented exit codes and `notes list --check` for stale-note checks (#179).
- Experimental Git controls show a saved note's status and can commit that note without pushing or changing unrelated staged files. Enable them with `VITE_ENABLE_NOTE_GIT=true` when building; they are off by default (#180).

### Changed

- Privacy and settings copy explains that Lightwell does not upload project notes, and that sharing the file through Git requires both committing and pushing it (#182).

### Fixed

- Commit diffs work in projects whose workspace folder is below the repository root or has no root Cargo.toml, such as Next.js workspaces. Diffs no longer fail with "Could not map the workspace" (#173).
- The source inspector shows the selected block after a changed-file diff was open. Selecting a block from search or with go-to-definition no longer keeps showing the earlier file (#174).
- Commit diffs attribute removed lines to the deleted symbol instead of the replacement symbol, including changes viewed across a commit range (#177).
- Saving project notes maintains `.lightwell/.gitignore` entries for lock and temporary files while keeping `notes.json` trackable and preserving existing user rules (#178).

## 0.1.17 - 2026-10-22

### Added

- In the source inspector, F12 or Ctrl/Cmd+click on a word that names a module opens that module's source. Ambiguous names and the inspected module itself are ignored (#171).

### Changed

- The README download link and the in-app privacy and terms links point to getlightwell.app (#163).

### Fixed

- Selecting a source file opens it in projects without a root Cargo.toml, such as Next.js workspaces (#162).
- The update check uses rustls-webpki 0.103.16 and webpki-root-certs 1.0.10, which fix RUSTSEC-2026-0382 and RUSTSEC-2026-0383 (#164).

## 0.1.16 - 2026-10-20

### Added

- In the file tree, arrow keys move focus between rows (#158).

### Changed

- Selecting a file in the file tree opens its source by default (#158).

### Fixed

- The Settings button stays clickable in a 920px-wide window (#157).
- Source and notes open for JavaScript-only workspaces (#152).

## 0.1.15 - 2026-10-18

### Added

- Commit diff discoverability: expand the summary strip to list changed blocks and map-external files with line counts, jump to a block and its inline diff, filter the map to **Only changed**, step with **Prev** / **Next** or `[` / `]`, and a short legend for line and connection highlights (#147).
- Settings stores a size for UI text, a size for source code, and a size for labels in the tree and on the map. Each one applies across that part of the app and is saved on this device (#145).
- The vertical file tree zooms from **−**, the percentage (reset), and **+**, or with Ctrl/Cmd +, Ctrl/Cmd −, and Ctrl/Cmd 0. The level is saved per workspace (#144).

### Fixed

- README **Updates** section describes in-app install for signed updates on macOS, Windows, and the Linux AppImage starting in 0.1.14 (#146).
- Kind badges, the header strip, and the block and connection counts use a larger default size (#145).
- The vertical file tree places each row's path and child count beside the name. The path column has a bounded width (#144).
- A C# namespace whose opening brace is on the next line stays block-scoped, so a later sibling type is not pulled into it. Method overloads keep separate commit-diff spans. C# and VB.NET type names keep non-ASCII characters (#143).

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
