# Playwright suite

Covers the `web` and `ipc` layers of [docs/feature-map.md](../docs/feature-map.md).
The 5 `ipc, app` flows are stage-2b (tauri-driver) and are not covered here;
they are listed as "not yet covered (stage 2b)" in the feature map's Coverage
table.

## Layers

- **web** — specs call `gotoWeb()` from [helpers.ts](./helpers.ts), which loads
  the fixture web build (`vite preview` of `npm run build`) as-is.
- **ipc** — specs call `gotoIpc()`, which installs a Tauri invoke handler
  before the app loads (`page.addInitScript`), replicating the mechanism of
  `mockIPC` from `@tauri-apps/api/mocks` (v2.12, the version in
  package.json): it defines `window.__TAURI_INTERNALS__.invoke` so
  `isTauri()` is true and the desktop map source runs. Commands are answered
  from [fixtures/captures.json](./fixtures/captures.json). The one difference
  from calling `mockIPC` directly is transport: the handler lives in an init
  script because the preview build cannot import the mocks module before the
  app bundle executes.

Every spec runs under a console gate: any `console.error` or uncaught page
error fails the test. The allowlist in helpers.ts is empty; no benign console
errors were observed.

## Captures

Regenerate with `node e2e/generate-captures.mjs`. The fixture is a minimal
sanitized subset — 4 blocks per workspace (root + crate + app + module) —
never the full scanned trees. Sources:

- **Real captures** — block structure, fingerprints, versions, and
  parentage come from the checked-in lightwell-core outputs
  (`maps/*.facts.json`, `maps/*.annotations.json`); commits are real
  `git log` entries from this repo; source reads return the real bytes of
  in-repo fixture files (`crates/lightwell-core/fixtures/**`,
  `Cargo.toml`). Free-text descriptions are dropped and every retained
  path / package / target / module identifier points at an in-repo fixture
  file, because the Prismattyc/Scorecard source trees are not in this repo.
- **Hand-built from the Rust/TS types** — `workspace_commit_changes`,
  `workspace_block_diff` / `workspace_path_diff`, and
  `editor_template_presets`: the fixture workspaces carry no git history and
  no editor install, so no real capture exists. Shapes follow
  `src/map-sources/tauri-types.ts` parsers exactly. Notes snapshots are
  stateful in the mock (add/edit/remove mutate an in-page store seeded
  empty), mirroring `.lightwell/notes.json` semantics.

## Run

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```
