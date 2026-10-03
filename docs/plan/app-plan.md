# CodeMap desktop app plan

## Product

CodeMap is for developers onboarding to a codebase and maintainers who need a quick view of its structure. The v0.1 loop is: open a repository folder, extract and display its map, refresh the map when source files change, then select a source block and open its file in the configured editor. Container blocks drill into their children; the detail panel offers the source action for a selected block.

v0.1 supports Rust workspaces, crate and module maps, dependency and feature edges, search, drill-down, annotations, live refresh, a desktop viewer, and a small CLI using the same extractor. It targets macOS and Linux. It excludes Windows packaging, non-Rust extraction, cloud services, team sync, generated call graphs, and architecture descriptions inferred by an LLM. Keep runtime map generation local.

## Shape

Use a Tauri desktop shell with the current Vite, React, React Flow, and ELK UI. Add one `codemap-core` Rust crate for workspace discovery, extraction, map types and serialization, fingerprints, annotation IO, and file watching. The Tauri commands call this crate; the `codemap` CLI calls it directly. Tauri commands provide the frontend-to-Rust boundary ([Tauri command guide](https://v2.tauri.app/develop/calling-rust/)).

Port the TypeScript Cargo extractor into `codemap-core` so the app and CLI have one source of extraction facts. Keep its current schema v1 output, stable block IDs, repository-relative paths, fingerprints, and `cargo metadata --no-deps` facts. Parse Rust module declarations with a Rust syntax parser, preserving the current handling of inline modules, `#[path]`, `cfg` attributes, and unresolved files. Keep the TypeScript viewer, schema validation, and annotation display. Replace the viewer's static map imports with a map-source interface: Tauri supplies the opened workspace; the browser preview can continue to load the checked-in fixtures. Compare Rust output with the existing Prismattyc and Scorecard maps before retiring the TypeScript extractor.

Language detection order:

1. **Rust:** detect `Cargo.toml`; use Cargo metadata for workspace packages, targets, features, and path dependencies, then walk Rust module declarations from each target.
2. **TypeScript and JavaScript:** detect `package.json`, with `tsconfig.json` or `jsconfig.json` as project hints; read source imports and package entry/export declarations.
3. **Python:** detect `pyproject.toml`, `setup.cfg`, or `setup.py`; map Python files, packages, and imports.
4. **Go:** detect `go.mod`; map packages and imports from Go source files.

Add each language as a parser behind the shared map model. Do not imply cross-language edges or resolve dynamic imports unless the source provides a concrete fact.

## Annotation overlay

Store shared notes in `.codemap/annotations.json` at the project root. Key them by stable block IDs and record the source fingerprint they describe, so refresh can mark stale notes without replacing them. Write this file only when a user adds or edits annotations; keep personal settings such as the selected editor in the app's user configuration, outside the repository.

## Packaging

For macOS, sign and notarize the app for Developer ID distribution using `Developer ID Application: Moonbase 2090 LLC (S24C53PD3Y)` and the `moonbase-notary` notary profile. Keep signing material in CI secrets/keychain handling; never commit it. Tauri's distribution guide documents the signing identity and notarization credential requirements ([Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)); Prismattyc's `docs/release-process.md` records the existing secret-handling and staple/validation flow.

For Linux, build against a glibc 2.28 floor and verify installation and execution on Amazon Linux 2023 with glibc 2.34. These are the existing Prismattyc release targets, documented in `~/Projects/Moonbase2090/Prismattyc/docs/release-process.md` and `.github/workflows/ci.yml`; AWS documents AL2023's glibc 2.34 in its [core toolchain reference](https://docs.aws.amazon.com/linux/al2023/ug/core-glibc.html). Windows packaging follows after the initial macOS and Linux release.

## Repository and CI after approval

After MB2090 approves a repository, create it under the `moonbase2090` organization, target pull requests at `main`, and run Scorecard in CI as a required quality gate. Keep build, format, lint, extraction-parity, and smoke-check commands in portable checked-in scripts that work locally and in CI; Rookrunner can call those scripts later. Follow Scorecard's documented CI invocation in `~/Projects/Moonbase2090/Scorecard/docs/how-to/ci.md`. Do not add Terraform.

## Milestones

Sizes are relative engineering estimates, not calendar commitments.

| Milestone | Scope | Size |
| --- | --- | --- |
| M1 — Shared Rust core and CLI | Port Rust extraction; retain schema v1; compare output with both current maps; expose extraction through `codemap`. | L |
| M2 — Desktop workflow | Add Tauri shell, folder selection, map-source adapter, existing viewer, editor configuration/open action, and live file refresh. | L |
| M3 — v0.1 release | Add project annotation IO and stale-note handling; portable CI scripts, Scorecard gate, macOS signing/notarization, and Linux glibc/AL2023 validation. | L |
| M4 — Language expansion | Add TypeScript/JavaScript, then Python, then Go parsers; add Windows packaging after the initial release. | XL |

## Open questions for MB2090

- What is the product name and the approved repository name?
- Which license and business model should apply: open source, paid, or another model? Resolve dependency-license fit before public distribution.
- May the repository be created under `moonbase2090`, with `main` as its default branch?
- Which editors must v0.1 support, and should the app use an explicit editor setting, `EDITOR`, or both?
- Should Rust extraction require Cargo installed on the user's machine, or should the core parse workspace manifests without invoking Cargo?
- Should CodeMap create `.codemap/annotations.json` on first edit, or ask before adding the shared file?
- What minimum macOS version should the release support? Set it from the selected runner/build matrix and document that source before making it a package requirement.

No repository-size, refresh-interval, graph-depth, or block-count limits are proposed here. Add a limit only when a benchmark or platform requirement supports it, and cite that source in the implementation plan.
