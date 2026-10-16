/// How this install can take an update.
///
/// macOS, Windows, and the Linux AppImage install through the updater.
/// deb, rpm, and the tarball only point at the release download.
#[tauri::command]
pub fn update_delivery() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_none() {
            return "manual";
        }
    }
    "integrated"
}
