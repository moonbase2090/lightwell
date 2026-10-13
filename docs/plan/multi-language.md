# Multi-language maps

Lightwell is adding source languages beyond Rust workspace manifests. TypeScript and Python are in scope next to the existing Rust/TOML pipeline.

## Product policy

TypeScript and Python are **first-class built-in packs** (extensions and registry routing land with the language registry). They do **not** use off-by-default feature flags once extraction and highlighting ship.

Until each pack registers a Monarch tokenizer and extractor, inspector Monaco ids for those paths stay on the **Rust fallback** (see `monacoLanguageIdForPath` in `src/languages/registry.ts`). That matches trunk feature gating in `REVIEW_POLICY.md` §5: new user-visible behavior stays off until the pack is complete.

When TypeScript or Python extractors and highlighters land, they ship **enabled by default** (no env toggle to hide map facts or syntax coloring). Optional dev-only toggles (for example project notes in the desktop shell) are unrelated.

This PR is registry + Rust workspace pack only; always-on TS/Python applies to follow-on PRs that wire extractors and `registerHighlighter`.

## Implementation notes

- Each language is a **`LanguagePack`** (`src/languages/language-pack.ts`): `id`, `extensions`, `extractor`, `registerHighlighter`, and `fixtures`. Built-ins live in `src/languages/builtin-packs.ts`; `LANGUAGE_PACKS` in `src/languages/registry.ts` is the active list a future plugin loader will append to (no loader yet).
- TypeScript and Python are the next built-in packs after Rust/TOML; extraction and Monarch tokenizers land per pack without feature flags.
- The built-in **Rust** pack (`src/languages/packs/rust.ts`) owns workspace extraction (`extract/cargo` + `lightwell_core::rust_source`), Rust and Cargo-manifest TOML Monarch tokenizers, and `crates/lightwell-core/fixtures`. The CLI calls `extractWorkspaceMap`, which delegates to that pack.
- Rust parsing stays in `crates/lightwell-core`; TypeScript mirrors live under `src/extract/` with parity checks in `scripts/check-rust-map-parity.mjs` where applicable.
- Schema and `docs/schema.md` gain per-block `language` fields as each extractor lands.
- Inspector highlighting registers through each pack’s `registerHighlighter` (Rust/TOML Monarch today; TS/Python as packs mature).

Keep pull requests small and rebased on `main`. Avoid path-handling churn that conflicts with cross-platform work; use `path_confinement` for filesystem scope.
