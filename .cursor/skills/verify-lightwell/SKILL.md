---
name: verify-lightwell
description: Drive Lightwell the way a user does — CLI extract and browser preview of checked-in workspace maps. Use for PR proof, release checks, or /maintain-verification-skill audits.
---

# Verify Lightwell

Lightwell ships three surfaces: a **browser preview** (checked-in Prismattyc and Scorecard maps), a **Rust CLI** (`lightwell extract`), and a **Tauri desktop app** (open a local Cargo workspace). Automated verification in CI and agents should prefer the CLI and static preview; desktop GUI proof needs a built Tauri binary and is optional locally.

## Launch

**CLI (isolated, per drive):** from the repository root, build once:

```sh
cargo build -p lightwell-cli --locked
```

Each extract proof uses a fresh output path under `/tmp/lightwell-verify-$RUN_ID/`.

**Browser preview (one server per run):** from the repository root:

```sh
npm ci
npm run build
npm run preview -- --host 127.0.0.1 --port "$PORT"
```

Choose `PORT` that is free (for example `4173` or `5000 + $RUN_ID % 1000`). Ready when `curl -fsS "http://127.0.0.1:$PORT/"` succeeds. Teardown: kill the preview process you started (record its PID); do not kill other `vite` processes by name.

Set `RUN_ID` to something unique per verification run (for example `date +%s` or the shell PID).

## Doctor

Run before the first drive and after any failed drive:

```sh
scripts/verify/doctor.sh
```

Requires exit code `0`. It checks Node.js, `npm ci` dependencies, Rust toolchain, and that `cargo build -p lightwell-cli --locked` succeeds.

## Drive

Read `.cursor/skills/verify-lightwell/features/README.md` and the feature file for the behavior under test. Follow its preconditions and commands literally.

Harness summary:

- **CLI:** `target/debug/lightwell` (after build) or `cargo run -p lightwell-cli --locked --` with `extract`, `--name`, and `-o`.
- **Browser:** HTTP against the preview URL; built `dist/` must exist (`npm run build`).

## Evidence

Store proof under `/tmp/lightwell-verify-$RUN_ID/proof/` (create the directory). Keep:

- CLI: command line, exit code, path to the written facts JSON, and the `CLI smoke passed` line from `scripts/verify/cli-extract-proof.sh`.
- Browser: preview URL, `curl` response code, and a note that `dist/index.html` contains `Lightwell` (from `scripts/verify/browser-preview-proof.sh`).

Proof must exercise a real user path from the feature map, not internal test-only hooks. Do not delete proof files during cleanup.

## Cleanup

- Stop the preview server you started (its PID only).
- Remove `/tmp/lightwell-verify-$RUN_ID/work/` if created; **keep** `/tmp/lightwell-verify-$RUN_ID/proof/`.

## Helpers

All helpers are executable from the repository root.

```sh
scripts/verify/doctor.sh
scripts/verify/cli-extract-proof.sh /tmp/lightwell-verify-$RUN_ID/proof/extract.json
scripts/verify/browser-preview-proof.sh 127.0.0.1 "$PORT" /tmp/lightwell-verify-$RUN_ID/proof
```

`cli-extract-proof.sh` prints `CLI smoke passed:` on success (same checks as `scripts/ci/smoke-cli.sh`). `browser-preview-proof.sh` expects preview already running on the given host and port.

## Windows

On Windows, `scripts/verify/doctor.sh` is a bash script. Run the same checks from the repository root with Node.js 22, Python 3, Git Bash, `ar` and `strings` on `PATH`, and the MSVC Rust toolchain:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
cargo test -p lightwell-core --lib --locked
cargo test -p lightwell-cli --locked
cargo test -p lightwell-app --bin lightwell --locked
```

`npm test` runs the shell checks through Git Bash. Keep proof under `$env:TEMP\lightwell-verify-$RUN_ID\proof` and leave machine paths out of anything that will be published.

After product changes to build commands, test commands, or primary user flows, run `/maintain-verification-skill`.
