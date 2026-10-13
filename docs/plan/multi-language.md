# Multi-language maps

Lightwell is adding source languages beyond Rust workspace manifests. TypeScript and Python are in scope next to the existing Rust/TOML pipeline.

## Product policy

TypeScript and Python are **first-class built-in packs**: extension routing and registry seams land with the language registry; behavior for each pack follows trunk **feature gating** in `REVIEW_POLICY.md` §5.

### Off by default, then on in a separate trunk PR

For each new language capability (workspace extraction, module facts, Monarch tokenizer):

1. **Land gated off** — The trunk PR that adds the extractor or `registerHighlighter` ships with the behavior **disabled by default** (flag, setting, or equivalent off path). Until enabled, inspector paths for that pack keep the **Rust Monaco fallback** (`monacoLanguageIdForPath` in `src/languages/registry.ts`); map facts from that extractor are not produced on the default CLI/viewer path.
2. **Enable in a follow-on trunk PR** — A later, dedicated trunk PR turns the flag or setting **on by default** (or removes the gate once policy allows). That PR is reviewed on its own; it is not bundled with the initial implementation.

Rust and Cargo-manifest TOML highlighting are the current on-by-default baseline. This registry PR does not enable TypeScript or Python extraction or highlighting.

Optional dev-only toggles (for example project notes in the desktop shell) are unrelated; §5 applies to language extraction and inspector highlighting.

## Implementation notes

- Each language is a **`LanguagePack`** (`src/languages/language-pack.ts`): `id`, `extensions`, `extractor`, `registerHighlighter`, and `fixtures`. Built-ins live in `src/languages/builtin-packs.ts`; `LANGUAGE_PACKS` in `src/languages/registry.ts` is the active list a future plugin loader will append to (no loader yet).
- TypeScript and Python are the next built-in packs after Rust/TOML; land extractors and Monarch tokenizers **per pack**, each behind default-off gating until the separate enable PR.
- The built-in **Rust** pack (`src/languages/packs/rust.ts`) owns workspace extraction (`extract/cargo` + `lightwell_core::rust_source`), Rust and Cargo-manifest TOML Monarch tokenizers, and `crates/lightwell-core/fixtures`. The CLI calls `extractWorkspaceMap`, which delegates to that pack.
- Rust parsing stays in `crates/lightwell-core`; TypeScript mirrors live under `src/extract/` with parity checks in `scripts/check-rust-map-parity.mjs` where applicable.
- Schema and `docs/schema.md` gain per-block `language` fields as each extractor lands (with the same off-then-on rollout).
- Inspector highlighting registers through each pack’s `registerHighlighter` (Rust/TOML Monarch today; TS/Python when gated on).

Keep pull requests small and rebased on `main`. Avoid path-handling churn that conflicts with cross-platform work; use `path_confinement` for filesystem scope.
