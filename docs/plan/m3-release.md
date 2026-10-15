# Lightwell M3 — v0.1 release

Status: in progress. Pull request 4 adds `.github/workflows/release.yml`
and `scripts/check-release-text.sh`. Publishing waits for a green
signed dry run and owner approval of the `v0.1.0` tag.

The milestone in `docs/plan/app-plan.md` is: finish portable release
checks, sign and notarize the macOS app, and verify the Linux glibc
2.28 package on Amazon Linux 2023. The base is `main` at
`64c1ac0ad977fffa46f2ca13806ceb4c5bdfb31e`.

Prismattyc `docs/release-process.md` and
`.github/workflows/release.yml` are the model for the Apple secret
names, the temporary keychain, notarize-then-staple, and a
`workflow_dispatch` dry run that does not publish. Lightwell does
not copy the six-binary updater, the Windows package, or the
universal-binary host. Those stay Prismattyc.

## Already on main

`.github/workflows/ci.yml` runs these jobs on pull requests to
`main` and `m2/**`:

| Job | What it already proves |
| --- | --- |
| `checks` | `npm test`, `npm run build`, `cargo fmt`, `cargo check`, the Rust tests, `scripts/smoke-project-notes.sh`, the CLI extract, live refresh, schema v1, and Scorecard `moonbase2090/Scorecard/action@v0.1.6`. |
| `macos-cli` | `cargo build --release --locked -p lightwell-cli` on `macos-26` with `MACOSX_DEPLOYMENT_TARGET=11.0`. `scripts/ci/smoke-cli.sh` runs `--help` and `extract`. `otool` must report minos `11.0`. |
| `linux-cli-al2023` | x86_64 and aarch64 CLI binaries from `scripts/ci/build-linux-cli.sh`, which calls `cargo zigbuild --target "$target.2.28"`. `scripts/ci/smoke-linux-al2023.sh` reads the GLIBC symbol floor and runs `extract` inside `amazonlinux:2023`. |
| `tauri-macos-artifact` | An unsigned Apple Silicon `.app` from `npm run tauri:build -- --target aarch64-apple-darwin --bundles app --no-sign`. `LSMinimumSystemVersion` is `11.0`. `codesign --verify` must fail. The zip artifact is `lightwell-macos-arm64-unsigned`. |
| `tauri-linux-artifact` | An x86_64 `.deb` from `cargo-zigbuild` for `x86_64-unknown-linux-gnu`. `scripts/ci/check-glibc-floor.sh` allows GLIBC 2.28 on the unpacked `lightwell` binary. The artifact is `lightwell-linux-x86_64-glibc-2.28`. |

`crates/lightwell-app/tauri.conf.json` already sets `version` to
`0.1.0`, `identifier` to `com.moonbase2090.lightwell`, bundle targets
`app` and `deb`, and `macOS.minimumSystemVersion` to `11.0`.
`package.json` is also `0.1.0`.

## Still open

Three gaps match the milestone.

Portable release checks. The macOS minimum check, the unsigned-app
check, and the `.deb` unpack step are inline shell in `ci.yml`.
`docs/plan/app-plan.md` says release commands live in checked-in
scripts that run locally and in CI.

The Linux package smoke. `linux-cli-al2023` runs the raw CLI in
`amazonlinux:2023`. `tauri-linux-artifact` checks the `.deb`
binary's GLIBC floor but never runs the packaged binary. That binary
is the Tauri desktop app, with no `--help` or `extract`, and Amazon
Linux 2023 has no WebKitGTK 4.1 runtime, so the app cannot run there.

Signed macOS distribution. `tauri-macos-artifact` is required to
stay unsigned. Nothing in this repository notarizes
`Developer ID Application: Moonbase 2090 LLC (S24C53PD3Y)` or uses
the `moonbase-notary` profile. There is no release workflow and no
publish job.

Windows packaging stays in M4.

## Pull requests

Each implementation pull request is one of the rows below, opened
only after sign-off, from `origin/main`. None of them commit a
certificate, a `.p12`, a `.p8`, or a notary profile.

### 1. Portable release checks

Scope. Move the release assertions that are already inline into
scripts, and call those scripts from the current jobs. Behavior
stays the same. No signing and no new secrets.

Files.

- `scripts/ci/check-macos-minimum.sh`, from the `otool` block in `macos-cli` and the `LSMinimumSystemVersion` read in `tauri-macos-artifact`
- `scripts/ci/check-unsigned-macos-app.sh`, from the `codesign --verify` refusal in `tauri-macos-artifact`
- `scripts/ci/check-deb-glibc.sh`, wrapping `dpkg-deb -x` plus the existing `scripts/ci/check-glibc-floor.sh`
- `.github/workflows/ci.yml`, jobs `macos-cli`, `tauri-macos-artifact`, and `tauri-linux-artifact`

Proof. On the current `macos-cli` and `tauri-macos-artifact`
outputs, the minimum-version script prints `11.0` and exits 0. The
unsigned-app script exits 0 on that unsigned bundle. The deb script
prints a GLIBC maximum at or below 2.28. A copy of the plist or
binary whose minimum is not `11.0`, a bundle that `codesign
--verify` accepts, or a binary whose GLIBC symbol is newer than
2.28 makes the matching script exit non-zero. That is the same
refusal the inline shell performs today.

Builds on `macos-cli`, `tauri-macos-artifact`,
`tauri-linux-artifact`, `scripts/ci/check-glibc-floor.sh`, and
`scripts/ci/smoke-cli.sh`.

### 2. Smoke the Linux package

Scope. The real `lightwell` CLI is smoke-tested on
`amazonlinux:2023` by `linux-cli-al2023`, which is what that image
supports. The desktop app in the x86_64 `.deb` gets a GUI smoke on
the `ubuntu-22.04` runner, where `libwebkit2gtk-4.1-dev` is
installed: unpack the `.deb`, launch the packaged binary under Xvfb,
and require a visible window and a screenshot of at least 800x500.
The `.deb` is not run on Amazon Linux 2023 and is not `dnf`
installed.

Files.

- `scripts/ci/smoke-deb-gui.sh`, wrapping `dpkg-deb -x` plus `scripts/ci/capture-open-workspace.sh`
- `.github/workflows/ci.yml`, job `tauri-linux-artifact`, after `scripts/ci/check-deb-glibc.sh`

Proof. The job log shows the packaged binary path and the
captured window size. A package with no `lightwell` binary, or one
that opens no window, makes the script exit non-zero. The GLIBC
floor stays enforced by `scripts/ci/check-deb-glibc.sh`. The
aarch64 CLI is covered by `linux-cli-al2023`; an aarch64 `.deb` is
not part of v0.1.

Builds on `tauri-linux-artifact`, `linux-cli-al2023`,
`scripts/ci/smoke-linux-al2023.sh`,
`scripts/ci/capture-open-workspace.sh`, and
`scripts/ci/check-deb-glibc.sh`.

### 3. Sign, notarize, and staple the macOS app

Scope. Add a pull-request job that produces a signed, notarized,
stapled Apple Silicon app. `tauri-macos-artifact` stays on
`--no-sign` and keeps the unsigned refusal. The new job imports
the Developer ID certificate into a temporary keychain, signs
`Lightwell.app` for
`Developer ID Application: Moonbase 2090 LLC (S24C53PD3Y)`,
submits the archive to Apple's notary service, staples the ticket,
and validates the staple. It uploads a zip artifact and does not
create a GitHub release. A local dry run, before CI, uses the
`moonbase-notary` notary profile on MB2090's machine. CI uses the
five repository secrets below and does not read a committed
profile.

Files.

- `.github/workflows/ci.yml`, new job `tauri-macos-signed` on `macos-26`
- `scripts/ci/sign-macos-app.sh`
- `scripts/ci/notarize-macos-app.sh`
- `crates/lightwell-app/tauri.conf.json` only if Tauri's signing block needs the identity name and the existing `minimumSystemVersion` of `11.0`

Proof. `codesign --verify --deep --strict` exits 0 and the
authority is the Developer ID above.
`spctl --assess --type execute` accepts the app.
`xcrun stapler validate` exits 0. `otool` or the plist still
reports minimum `11.0`. The unsigned job still fails
`codesign --verify` on its own artifact. Removing the certificate
import, or pointing the identity at a different team, makes
`codesign --verify` exit non-zero.

Builds on `tauri-macos-artifact`,
`crates/lightwell-app/tauri.conf.json`, the Packaging section of
`docs/plan/app-plan.md`, and Prismattyc `docs/release-process.md`
sections "Configure Apple credentials" and "Build platform
packages". Prismattyc's `apple` job in
`.github/workflows/release.yml` is the keychain and
notarize-then-staple sequence. Lightwell signs one Tauri app, not
Prismattyc's nested helper set.

### 4. Publish v0.1.0

Scope. Add a release workflow. Pushing the tag `v0.1.0` builds the
signed macOS app and the x86_64 glibc 2.28 `.deb`, reruns the
Amazon Linux 2023 package smoke, and publishes a GitHub release
only after both succeed. `workflow_dispatch` with a dry-run input
builds and notarizes without creating or pushing a tag and without
publishing. The tag version matches `0.1.0` in
`crates/lightwell-app/tauri.conf.json` and `package.json`. The
release assets are the stapled macOS zip and the `.deb`, plus one
`SHA256SUMS` file. There is no updater manifest. Later releases name
every installer `Lightwell_<version>_<arch>.<ext>`: the disk image is
`Lightwell_<version>_aarch64.dmg`, next to `Lightwell_<version>_amd64.deb`
and `Lightwell_<version>_x64.msi`. The publish job refuses any asset
without the version, then writes `SHA256SUMS` over the rest.

Files.

- `.github/workflows/release.yml`
- `docs/plan/m3-release.md`, a short "Published" note added in that same pull request after the first dry run is green

Proof. A dry-run dispatch from `main` finishes with the signed app
and the `.deb` uploaded as workflow artifacts and with no GitHub
release created. A tag push of `v0.1.0` creates the release only
when `tauri-macos-signed` and the Amazon Linux 2023 package smoke
both succeed. Publishing with either job failed is the break: the
publish job must not run.

Builds on pull requests 1–3, Prismattyc `docs/release-process.md`
sections "Prepare a release" and "Run a signed dry run", and the
`publish` job in Prismattyc `.github/workflows/release.yml`.

## What MB2090 provides

The agent does not sign in to Apple, does not open the Apple
developer account, and does not read secret files. MB2090 does
these steps himself before pull request 3 can go green.

1. Confirm the Developer ID Application certificate for Moonbase 2090 LLC, team `S24C53PD3Y`.
2. Export that certificate as a `.p12` and store it, with its password, as repository secrets on `moonbase2090/lightwell`.
3. Create an App Store Connect API key that can submit notarization requests, and store the issuer ID, key ID, and key.
4. Create a local `notarytool` profile named `moonbase-notary` for his own dry run. That profile stays in his login keychain.

CI secret names match Prismattyc `docs/release-process.md`:

| Secret | What he stores |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_NOTARY_ISSUER` | App Store Connect issuer ID |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARY_KEY` | App Store Connect `.p8` PEM or base64-encoded PEM |

The workflow creates a temporary keychain, imports the
certificate, and deletes that keychain when the job exits. The
`.p12`, the `.p8`, and the `moonbase-notary` profile are never
committed.

## v0.1.0 ships unsigned on macOS

v0.1.0 publishes the Apple Silicon app unsigned, alongside the Linux
`.deb`. The `macos-unsigned` release job builds with `--no-sign` and
requires `codesign --verify` to refuse the bundle, so nothing claims
to be signed or notarized. The signed job runs instead once the Apple
secrets import cleanly and the repository variable
`LIGHTWELL_MACOS_SIGNING` is set to `true`.
