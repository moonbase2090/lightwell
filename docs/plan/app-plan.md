# Lightwell desktop app plan

## Product

Lightwell is for developers onboarding to a codebase and maintainers who need a quick view of its structure. Its tagline is "turning the lights on in the Dark Factory". The v0.1 loop is: open a repository folder, extract and display its map, refresh the map when source files change, then click a block to inspect its source. Container blocks drill into their children; the detail panel offers the source action for a selected block.

v0.1 supports Rust workspaces, crate and module maps, dependency and feature edges, search, drill-down, notes, live refresh, a desktop viewer, and a small CLI using the same extractor. It targets macOS and Linux. It excludes Windows packaging, non-Rust extraction, cloud services, team sync, generated call graphs, and architecture descriptions inferred by an LLM. Keep runtime map generation local.

## Shape

Use a Tauri desktop shell with the current Vite, React, React Flow, and ELK UI. Add one `lightwell-core` Rust crate for workspace discovery, extraction, map types and serialization, fingerprints, and file watching. The Tauri commands call this crate; the `lightwell` CLI calls it directly. Tauri commands provide the frontend-to-Rust boundary ([Tauri command guide](https://v2.tauri.app/develop/calling-rust/)).

Port the TypeScript extractor into `lightwell-core` so the app and CLI have one source of extraction facts. Run `cargo metadata --no-deps` when Cargo is installed; if it is unavailable, parse Cargo manifests and Rust sources directly. Normalize both paths into the same model. Keep schema v1 output, stable block IDs, repository-relative paths, and fingerprints. Keep the TypeScript viewer, schema validation, and note display. Replace the viewer's static map imports with a map-source interface: Tauri supplies the opened workspace; the browser preview can continue to load checked-in fixtures. Compare Rust output with the existing Prismattyc and Scorecard maps before retiring the TypeScript extractor.

Language detection order:

1. **Rust:** detect `Cargo.toml`; use `cargo metadata` when Cargo is installed, otherwise read manifests directly. Discover workspace packages, targets, features, and path dependencies, then walk Rust module declarations from each target.
2. **TypeScript and JavaScript:** detect `package.json`, with `tsconfig.json` or `jsconfig.json` as project hints; read source imports and package entry/export declarations.
3. **Python:** detect `pyproject.toml`, `setup.cfg`, or `setup.py`; map Python files, packages, and imports.
4. **Go:** detect `go.mod`; map packages and imports from Go source files.

Add each language as a parser behind the shared map model. Do not imply cross-language edges or resolve dynamic imports unless the source provides a concrete fact.

## Project notes

Store project notes in `.lightwell/notes.json`, creating the directory and file on the first saved note. Key notes by stable block IDs and record the source fingerprint they describe, so refresh can mark stale notes without replacing them. Keep personal settings such as the selected editor in the app's user configuration, outside the repository.

Project notes are on in default builds. Set `VITE_ENABLE_PROJECT_NOTES=false` when building the app to omit the notes commands and leave the dialog unwired. The dialog code stays in the bundle.

## Editor action

Clicking a block opens its source in a read-only Monaco inspector, scrolled to that block. Use **Open in editor** to edit the file in another application. By default, launch the operating system's default app for that file type with `open` on macOS or `xdg-open` on Linux. Set an optional command template in the Editor settings panel; Lightwell stores it in the app's user configuration, outside the repository. The template may include file, line, and column placeholders. Ship a few ready-made templates for common launch forms, including JetBrains IDEs, Kiro, Zed, VS Code, Cursor, and vim in a terminal. These presets are examples, not an allowlist; accept arbitrary templates. If the OS handler or configured template cannot launch, or no handler is available, fall back to `VISUAL`, then `EDITOR`.

## Packaging

For macOS, support macOS 11.0 and later, matching Prismattyc's `LSMinimumSystemVersion` in [`Info.plist`](https://github.com/moonbase2090/Prismattyc/blob/f8650be8ec26cfa9b167abf3598cb207ded5969c/crates/prismattyc-host/macos/Info.plist). Sign and notarize the app for Developer ID distribution using `Developer ID Application: Moonbase 2090 LLC (S24C53PD3Y)` and the `moonbase-notary` notary profile. Keep signing material in CI secrets/keychain handling; never commit it. Tauri's distribution guide documents the signing identity and notarization credential requirements ([Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)); Prismattyc's `docs/release-process.md` records the existing secret-handling and staple/validation flow.

For Linux, build against a glibc 2.28 floor and verify installation and execution on Amazon Linux 2023 with glibc 2.34. These are the existing Prismattyc release targets, documented in `~/Projects/Moonbase2090/Prismattyc/docs/release-process.md` and `.github/workflows/ci.yml`; AWS documents AL2023's glibc 2.34 in its [core toolchain reference](https://docs.aws.amazon.com/linux/al2023/ug/core-glibc.html). Windows packaging follows after the initial macOS and Linux release.

## Repository and CI

The private `moonbase2090/lightwell` repository uses `main`. Lightwell uses the MPL-2.0 license, matching the [Prismattyc workspace](https://github.com/moonbase2090/Prismattyc/blob/f8650be8ec26cfa9b167abf3598cb207ded5969c/Cargo.toml) and [Scorecard workspace](https://github.com/moonbase2090/Scorecard/blob/7bb8b3f107fdbc343e46a06b9497a43afd0aa523/Cargo.toml); keep this repository private. Its pull request workflow builds the viewer and Rust workspace and runs Scorecard. Keep build, format, lint, extraction-parity, and smoke-check commands in portable checked-in scripts that work locally and in CI; Rookrunner can call those scripts later. Follow Scorecard's documented CI invocation in `~/Projects/Moonbase2090/Scorecard/docs/how-to/ci.md`. Do not add Terraform.

## Milestones

Sizes are relative engineering estimates, not calendar commitments.

| Milestone | Scope | Size |
| --- | --- | --- |
| M1 — Shared Rust core and CLI | Port Rust extraction; retain schema v1; compare output with both current maps; expose extraction through `lightwell`. | L |
| M2 — Desktop workflow | Add the Tauri shell, workspace picker, map-source adapter, source inspector, editor action, live refresh, and project notes dialog over the existing `lightwell-core` notes IO. | L |
| M3 — v0.1 release | Finish portable release checks, sign and notarize the macOS app, and verify the Linux glibc 2.28 package on Amazon Linux 2023. | L |
| M4 — Language expansion | Add TypeScript/JavaScript, then Python, then Go parsers; add Windows packaging after the initial release. | XL |

## Decisions

- Business model: open core.
- License: MPL-2.0. Keep the GitHub repository private.
- Rust extraction: use `cargo metadata --no-deps` when Cargo is installed; otherwise parse Cargo manifests and Rust sources directly.
- Notes: store them in `.lightwell/notes.json`, created on the first save.
- Minimum macOS version: 11.0, matching Prismattyc.
- Editor behavior: clicking a block opens a read-only Monaco inspector at that block. **Open in editor** launches the OS default app unless the user sets a command template. Templates accept file, line, and column placeholders, with `VISUAL` and `EDITOR` as fallbacks. Ship a few presets, including JetBrains IDEs, Kiro, Zed, VS Code, Cursor, and vim in a terminal, but accept arbitrary commands without a fixed supported-editor list.

No repository-size, refresh-interval, graph-depth, or block-count limits are proposed here. Add a limit only when a benchmark or platform requirement supports it, and cite that source in the implementation plan.
