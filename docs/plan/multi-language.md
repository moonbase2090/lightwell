# Multi-language maps

Lightwell is adding source languages beyond Rust workspace manifests. TypeScript and Python are in scope next to the existing Rust/TOML pipeline.

## Product policy

TypeScript and Python are **first-class built-in packs**. Extension routing lands with the language registry. Extraction, outline facts, and inspector highlighting ship **on by default** when a pack implements them. Do not gate those behaviors behind an off-by-default flag or setting.

Python module extraction and its Monarch tokenizer are on. TypeScript is registered, and its extractor turns on in the same way when that pack lands. There is no separate enable PR and no off switch.

Rust and Cargo-manifest TOML highlighting stay on. Paths with no registered tokenizer still use the Rust Monaco fallback (`monacoLanguageIdForPath` in `src/languages/registry.ts`).

Optional dev-only toggles (for example project notes in the desktop shell) are unrelated.

## Implementation notes

- Each language is a **`LanguagePack`** (`src/languages/language-pack.ts`): `id`, `extensions`, `extractor`, `registerHighlighter`, and `fixtures`. Built-ins live in `src/languages/builtin-packs.ts`; `LANGUAGE_PACKS` in `src/languages/registry.ts` is the active list a future plugin loader will append to (no loader yet).
- TypeScript and Python are the next built-in packs after Rust/TOML. Land each pack's extractor and Monarch tokenizer on by default. Python does this in `extract/python-modules` and `lightwell_core::python_source`, called from workspace extraction.
- The built-in **Rust** pack (`src/languages/packs/rust.ts`) owns workspace extraction (`extract/cargo` + `lightwell_core::rust_source`), Rust and Cargo-manifest TOML Monarch tokenizers, and `crates/lightwell-core/fixtures`. The CLI calls `extractWorkspaceMap`, which delegates to that pack.
- Rust parsing stays in `crates/lightwell-core`; TypeScript mirrors live under `src/extract/` with parity checks in `scripts/check-rust-map-parity.mjs` where applicable.
- Schema and `docs/schema.md` gain per-block `language` fields as each extractor lands. Rust modules omit `language`.
- Inspector highlighting registers through each pack’s `registerHighlighter` (Rust, TOML, and Python Monarch today).

Keep pull requests small and rebased on `main`. Avoid path-handling churn that conflicts with cross-platform work; use `path_confinement` for filesystem scope.
