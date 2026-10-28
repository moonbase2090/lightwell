# AGENTS.md

Lightwell maps Rust workspaces, TypeScript, JavaScript, HTML and CSS projects (including React and Next.js), Python modules, Go packages, and C# and VB.NET projects. It shows crates, entry points, modules, Cargo features, dependency edges, and product notes in a React viewer and Tauri desktop app.

Run `./scripts/install-hooks.sh` once per clone (or `scripts/install-hooks.ps1` on Windows) so staged `.rs` files are checked with `rustfmt` before each commit.

## Run the tests

```sh
npm ci
npm test
cargo test -p lightwell-core --lib --locked
cargo test -p lightwell-app --bin lightwell --locked
```

On macOS, `scripts/ci/test-macos-cli-path.sh` checks that a fresh shell resolves the bundled `lightwell` command. `scripts/ci/bundle-macos-cli.sh` copies that command into `Lightwell.app` after `tauri build` and before signing.

## Tests

No tautological tests. A test must fail when the behavior it covers breaks. Don't write tests that:

- assert a value against itself, or a constant against the same constant
- compute the expected value with the code under test or a copy of its logic
- mock or stub the unit under test, then assert what the mock returns
- only check that something ran, was called, or didn't throw or panic, with no assertion on the result
- compare against a snapshot or golden file regenerated from current output without review
- still pass when the implementation is deleted or replaced with a stub or default

Review rejects tests like these.
