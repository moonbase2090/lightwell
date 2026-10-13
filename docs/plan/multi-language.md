# Multi-language maps

Lightwell is adding source languages beyond Rust workspace manifests. TypeScript and Python are in scope next to the existing Rust/TOML pipeline.

## Product policy

TypeScript/JavaScript/HTML/CSS (the **web** pack), **React** (`.jsx`/`.tsx` components), **Next.js** (`app/` and `pages/` route files, `next.config.*`), and Python are **first-class for v0.1.4**. Other meta-frameworks and bundlers are follow-up PRs after release. Extension routing lands with the language registry. Extraction, outline facts, and inspector highlighting ship **on by default** when a pack implements them. Do not gate those behaviors behind an off-by-default flag or setting.

Python module extraction and its Monarch tokenizer are on. The web pack (TS/JS/JSX/TSX, HTML, CSS/SCSS, `package.json` / `tsconfig` / framework configs) extracts module facts and registers Monaco highlighting on. There is no separate enable PR and no off switch.

Rust and Cargo-manifest TOML highlighting stay on. Paths with no registered tokenizer still use the Rust Monaco fallback (`monacoLanguageIdForPath` in `src/languages/registry.ts`).

Optional dev-only toggles (for example project notes in the desktop shell) are unrelated.

## Implementation notes

- Each language is a **`LanguagePack`** (`src/languages/language-pack.ts`): `id`, `extensions`, `extractor`, `registerHighlighter`, and `fixtures`. Built-ins live in `src/languages/builtin-packs.ts`; `LANGUAGE_PACKS` in `src/languages/registry.ts` is the active list a future plugin loader will append to (no loader yet).
- Web and Python are built-in packs after Rust/TOML. Python uses `extract/python-modules` and `lightwell_core::python_source`. Web uses `extract/web-modules` and `lightwell_core::typescript_source`. Both run from workspace extraction.
- The built-in **Rust** pack (`src/languages/packs/rust.ts`) owns workspace extraction (`extract/cargo` + `lightwell_core::rust_source`), Rust and Cargo-manifest TOML Monarch tokenizers, and `crates/lightwell-core/fixtures`. The CLI calls `extractWorkspaceMap`, which delegates to that pack.
- Rust parsing stays in `crates/lightwell-core`; TypeScript mirrors live under `src/extract/` with parity checks in `scripts/check-rust-map-parity.mjs` where applicable.
- Schema and `docs/schema.md` gain per-block `language` fields as each extractor lands. Rust modules omit `language`.
- Inspector highlighting registers through each pack’s `registerHighlighter` (Rust, TOML, Python, and web TypeScript Monarch today).

Keep pull requests small and rebased on `main`. Avoid path-handling churn that conflicts with cross-platform work; use `path_confinement` for filesystem scope.
