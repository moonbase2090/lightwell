# Linux folder-dialog verification

Source revision: `ccde5f346c5f6faf7cfd0b53df8151cfaf5aaa9e`.
Source tree: `8364c9be7d4934a94189bafd141c117f99448131`.

Passed in a fresh Ubuntu 24.04.5 ARM64 VM with Rust 1.92.0, Node.js 22.23.5 and npm 10.9.9. The tracked source remained unchanged after the production build. The throwaway VM was terminated after the run, and termination was verified.

## Build and packages

Executed from the fresh checkout:

```sh
npm ci
npm run build
npm test
npm run tauri:build -- --bundles deb,rpm
cargo tree --locked -i glib
cargo build --release --locked -p lightwell-cli
```

All 398 frontend tests passed. The optimized desktop build and both packages passed. The dependency graph selected only glib 0.22.11, with no git sources. The CLI reported `lightwell 0.1.35` and extracted the fixture map.

The deb declares `zenity, libwebkit2gtk-4.1-0, libgtk-3-0`; the ARM64 rpm also declares `zenity`. See [build output](build-summary.txt), [deb metadata](deb-inspection.txt), [rpm metadata](rpm-inspection.txt), [package hashes](package-sha256.txt) and [environment](environment.txt).

## Native drive

Each case started with fresh configuration, data and cache directories. Both selected a real Rust workspace through the native picker, opened its source, and displayed the literal `folder selection worked`. Reopening the picker and dismissing it with Escape preserved the same workspace and source without a new visible error.

| Case | Actual picker process | Open and source | Dismissal |
| --- | --- | --- | --- |
| Portal | `xdg-desktop-portal-gtk` | PASS | PASS |
| Missing session bus | `zenity` | PASS | PASS |

The portal trace contains two `OpenFile` requests, a successful response with the fixture URI, then a non-success dismissal with empty URIs. The fixture path is redacted in the [session trace](portal-session.log). The second case explicitly pointed the app at a missing session bus and verified the picker process was `zenity`.

[Portal result](portal-result.json), [fallback result](fallback-result.json), [termination record](termination.json).

| Case | Picker | Loaded source | After dismissal |
| --- | --- | --- | --- |
| Portal | [capture](portal-picker.png) | [capture](portal-source.png) | [capture](portal-after-cancel.png) |
| Fallback | [capture](fallback-picker.png) | [capture](fallback-source.png) | [capture](fallback-after-cancel.png) |

## Repeat the drive

Use a clean Linux desktop environment with the documented build dependencies, a portal backend, `zenity`, Xvfb, Xauth, Xdotool, ImageMagick, Tesseract and Python 3. Retain the built desktop executable before building the CLI, since both executables use the same output name. Create `$HOME/dialog-proof` as a Rust package named `dialog-proof`, with this `src/lib.rs`:

```rust
pub fn dialog_marker() -> &'static str {
    "folder selection worked"
}
```

Use a fresh output directory for each invocation. `app_binary` must be the absolute path to the production desktop executable. Run the [driver](drive-dialogs.py) from an X11 desktop, or use:

```sh
export GDK_BACKEND=x11 XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1
capture_root=$(mktemp -d)
xvfb-run -a --server-args='-screen 0 1440x900x24' dbus-run-session -- \
  python3 drive-dialogs.py portal "$app_binary" "$capture_root/portal"
xvfb-run -a --server-args='-screen 0 1440x900x24' \
  python3 drive-dialogs.py fallback "$app_binary" "$capture_root/fallback"
```

The driver checks native process ownership and visible workspace/source content. It adjusts contrast for OCR of native picker controls; the retained screenshots are the original captures.
