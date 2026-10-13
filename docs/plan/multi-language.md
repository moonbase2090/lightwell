# Multi-language maps

Lightwell is adding source languages beyond Rust workspace manifests. TypeScript and Python are in scope next to the existing Rust/TOML pipeline.

## Product policy

TypeScript and Python support **ship enabled by default**. Do not gate extraction, outline facts, or inspector highlighting behind an off-by-default feature flag or environment toggle. When a workspace contains supported sources, they are parsed and shown like Rust modules today.

Optional dev-only toggles (for example project notes in the desktop shell) are unrelated; this policy applies to language extraction and map facts only.

## Implementation notes

- Each language is a **`LanguagePack`** (`src/languages/language-pack.ts`): `id`, `extensions`, `extractor`, `registerHighlighter`, and `fixtures`. Built-ins live in `src/languages/builtin-packs.ts`; `LANGUAGE_PACKS` in `src/languages/registry.ts` is the active list a future plugin loader will append to (no loader yet).
- TypeScript and Python are the next built-in packs after Rust/TOML; extraction and Monarch tokenizers land per pack without feature flags.
- Rust parsing stays in `crates/lightwell-core`; TypeScript mirrors live under `src/extract/` with parity checks in `scripts/check-rust-map-parity.mjs` where applicable.
- Schema and `docs/schema.md` gain per-block `language` fields as each extractor lands.
- Inspector highlighting registers through each pack’s `registerHighlighter` (Rust/TOML Monarch today; TS/Python as packs mature).

Keep pull requests small and rebased on `main`. Avoid path-handling churn that conflicts with cross-platform work; use `path_confinement` for filesystem scope.
