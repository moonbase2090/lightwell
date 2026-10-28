# macOS command on PATH

After Lightwell.app is opened, a new shell can run `lightwell`.

## Sub-features

- `path-link` — the app links `Contents/Resources/bin/lightwell` into `/usr/local/bin` when that directory exists and is writable, otherwise `~/.local/bin`.
- `fresh-shell` — a shell with a login-like `PATH` resolves `lightwell` to that link.

## How to get to it (user POV)

- Install Lightwell from the macOS disk image and open the app.
- Open a new terminal and run `command -v lightwell`, then `lightwell --help`.

## Driving it

Preconditions:

- macOS.
- `scripts/verify/doctor.sh` succeeded, or Rust and Node.js 22 are already available.
- The proof does not need a signed app. It builds a fake app tree.

From the repository root:

```sh
scripts/ci/test-macos-cli-path.sh
```

Expect exit `0` and a final line `macOS CLI path proof passed`. The script checks both the `~/.local/bin` fallback and a writable stand-in for `/usr/local/bin`. It does not edit shell profiles or the machine's real `/usr/local/bin`.

## Gotchas

- `~/.local/bin` is not on the default macOS `PATH`. When `/usr/local/bin` is missing or not writable, the app prints that the fallback directory is not on `PATH`.
- The desktop binary and the command line tool are different files. The PATH link must not point at `Contents/MacOS/lightwell`.
