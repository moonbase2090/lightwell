# Multi-language maps

Lightwell is adding source languages beyond Rust workspace manifests. TypeScript and Python are in scope next to the existing Rust/TOML pipeline.

## Product policy

**v0.1.4 language surface (on by default, no flag):**

- Core **TypeScript / JavaScript** (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`)
- **HTML**, **CSS**, and **SCSS**
- **React** components (`.jsx` / `.tsx` export scan)
- **Next.js** (`app/` and `pages/` route trees, `next.config.*`, route metadata on segment files)
- **Python** (existing pack)
- **Go** (`.go` packages when `go.mod` is present)
- **C# and VB.NET** (one .NET pack, on by default): solutions and projects, namespaces, types, methods, project references, and resolved type names. `bin/` and `obj/` are skipped.

Vue, Svelte, Astro, Angular, other meta-frameworks, and bundler/monorepo orchestrator graphs ship **after v0.1.4** in follow-up PRs.

Extension routing lands with the language registry. Extraction, outline facts, and inspector highlighting for language packs ship **on in the same trunk PR that adds the pack**. This follows `REVIEW_POLICY.md` **§5 language-pack exception** (not the default off-by-default feature gating in §5’s first paragraph). Do **not** land extractors or `registerHighlighter` behind a default-off flag with a later “enable” PR — that pattern does not apply to language packs.

Python module extraction and its Monarch tokenizer are on. The web pack extracts module facts and registers Monaco highlighting on. There is no separate enable PR and no off switch.

Rust and Cargo-manifest TOML highlighting stay on. Paths with no registered tokenizer still use the Rust Monaco fallback (`monacoLanguageIdForPath` in `src/languages/registry.ts`).

Optional dev-only toggles (for example project notes in the desktop shell) are unrelated.

## Implementation notes

- Each language is a **`LanguagePack`** (`src/languages/language-pack.ts`): `id`, `extensions`, `extractor`, `registerHighlighter`, and `fixtures`. Built-ins live in `src/languages/builtin-packs.ts`; `LANGUAGE_PACKS` in `src/languages/registry.ts` is the active list a future plugin loader will append to (no loader yet).
- Web, Python, Go, and .NET are built-in packs after Rust/TOML. Python uses `extract/python-modules` and `lightwell_core::python_source`. Web uses `extract/web-modules` and `lightwell_core::typescript_source`. Go uses `extract/go-modules` and `lightwell_core::go_source`. C# and VB.NET use `extract/dotnet-modules` and `lightwell_core::dotnet_source`. All run from workspace extraction on every map build (always on).
- The built-in **Rust** pack (`src/languages/packs/rust.ts`) owns workspace extraction (`extract/cargo` + `lightwell_core::rust_source`), Rust and Cargo-manifest TOML Monarch tokenizers, and `crates/lightwell-core/fixtures`. The CLI calls `extractWorkspaceMap`, which delegates to that pack.
- Rust parsing stays in `crates/lightwell-core`; TypeScript mirrors live under `src/extract/` with parity checks in `scripts/check-rust-map-parity.mjs` where applicable.
- Schema and `docs/schema.md` gain per-block `language` fields as each extractor lands. Rust modules omit `language`.
- Inspector highlighting registers through each pack’s `registerHighlighter` (Rust, TOML, Python, Go, web, C#, and VB.NET Monarch today).

Keep pull requests small and rebased on `main`. Avoid path-handling churn that conflicts with cross-platform work; use `path_confinement` for filesystem scope.
