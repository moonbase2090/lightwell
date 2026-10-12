# CLI workspace extract

A developer runs `lightwell extract` on a Cargo workspace and gets a schema v1 facts JSON with blocks and stats.

## Sub-features

- `extract-help` — `lightwell --help` exits zero.
- `extract-repo` — `lightwell extract` on the Lightwell repo writes facts with blocks.

## How to get to it (user POV)

- Install or build the `lightwell` CLI from this repository.
- Run `lightwell extract <workspace> -o <file> --name <label>` from a shell.

## Driving it with CLI

Preconditions:

- `scripts/verify/doctor.sh` succeeded.
- `cargo build -p lightwell-cli --locked` completed.

- **Help:** run `target/debug/lightwell --help`; expect exit `0` and usage mentioning `extract`.
- **Extract:** run `scripts/verify/cli-extract-proof.sh /tmp/lightwell-verify-$RUN_ID/proof/lightwell-map.json`; expect stdout containing `CLI smoke passed:` and a facts file with `schemaVersion` 1 and non-empty `blocks`.

## Gotchas

- Use the repository root as the workspace path so Cargo metadata matches CI.
- Locked builds (`--locked`) must match `Cargo.lock`; run `cargo build` without `--locked` only when intentionally updating the lockfile in another change.
