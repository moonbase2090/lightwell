# Linux file dialogs

Run after changing the Linux desktop dependency stack or file-dialog backend. Build and exercise the exact revision in a clean Linux VM.

## Preconditions

- Rust 1.92 or newer, the Linux desktop build dependencies, and the D-Bus development package.
- A built desktop app with its production viewer embedded. Build the frontend, then run `cargo build --locked --release -p lightwell-app --features tauri/custom-protocol`.
- A desktop session with a working D-Bus session, an XDG desktop portal backend, and `zenity` for the fallback case. Xvfb drives also need a session bus whose activation environment includes the test display.
- The CLI doctor and baseline feature-map preconditions pass.

## Create a workspace

```sh
dialog_proof=$(mktemp -d)
mkdir -p "$dialog_proof/workspace/src" "$dialog_proof/config" "$dialog_proof/data" "$dialog_proof/cache"
printf '[package]\nname = "dialog-proof"\nversion = "0.0.0"\nedition = "2021"\n' > "$dialog_proof/workspace/Cargo.toml"
printf 'pub const DIALOG_MARKER: &str = "folder selection worked";\n' > "$dialog_proof/workspace/src/lib.rs"
```

Set `app_binary` to the absolute built desktop binary. Launch it from the desktop session:

```sh
env XDG_CONFIG_HOME="$dialog_proof/config" XDG_DATA_HOME="$dialog_proof/data" \
  XDG_CACHE_HOME="$dialog_proof/cache" "$app_binary"
```

## Portal drive

1. Choose **Open workspace** and capture the native folder picker before accepting a folder. Select `$dialog_proof/workspace`.
2. Require the loaded workspace name `dialog-proof`. Inspect its source and require the literal `folder selection worked` marker.
3. Open the folder picker again and cancel. Require the same workspace and source to remain visible, without a new error.
4. Retain the folder-picker and loaded-workspace screenshots. Confirm the portal handled the request using the session bus or portal service log; a fallback picker alone does not pass this case.

## Fallback drive

Close only the app started for this run. Use fresh config/data/cache directories for the next launch. Keep the display available and point this process at a missing session bus:

```sh
mkdir -p "$dialog_proof/fallback-config" "$dialog_proof/fallback-data" "$dialog_proof/fallback-cache"
env DBUS_SESSION_BUS_ADDRESS="unix:path=$dialog_proof/missing-bus" \
  XDG_CONFIG_HOME="$dialog_proof/fallback-config" XDG_DATA_HOME="$dialog_proof/fallback-data" \
  XDG_CACHE_HOME="$dialog_proof/fallback-cache" "$app_binary"
```

Repeat the open, source-marker and cancel checks. Require a visible fallback picker and a successfully loaded workspace despite the unavailable portal. Retain both screenshots and any error output.

The drive passes only when both picker paths load the expected workspace and cancellation preserves it. A compile-only result, a browser preview or a workspace loaded from preseeded recent history leaves this drive pending.

## Evidence and cleanup

Keep the revision, Rust version, commands and exit codes, selected glib/GTK versions, portal request evidence, and picker/workspace screenshots for both cases. Scrub private paths before posting proof. Stop only the app, display, bus and VM created for this drive; retain the proof files.
