# AGENTS.md

Lightwell maps Rust workspaces and shows their crates, entry points, modules, Cargo features, dependency edges, and product notes in a React viewer and Tauri desktop app.

## Run the tests

```sh
npm ci
npm test
cargo test -p lightwell-core --lib --locked
cargo test -p lightwell-app --bin lightwell --locked
```

## Tests

No tautological tests. A test must fail when the behavior it covers breaks. Don't write tests that:

- assert a value against itself, or a constant against the same constant
- compute the expected value with the code under test or a copy of its logic
- mock or stub the unit under test, then assert what the mock returns
- only check that something ran, was called, or didn't throw or panic, with no assertion on the result
- compare against a snapshot or golden file regenerated from current output without review
- still pass when the implementation is deleted or replaced with a stub or default

Review rejects tests like these.
