fn main() {
    // Match the UI build flag so Mark reviewed / Delete stale IPC exists only when
    // the frontend wires those actions (VITE_ENABLE_NOTES_STALE_ACTIONS=true).
    // LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS=true also enables registration for local
    // app builds that share the CLI opt-in name.
    println!("cargo:rustc-check-cfg=cfg(lightwell_notes_stale_actions)");
    let enabled = std::env::var("VITE_ENABLE_NOTES_STALE_ACTIONS").as_deref() == Ok("true")
        || std::env::var("LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS").as_deref() == Ok("true");
    if enabled {
        println!("cargo:rustc-cfg=lightwell_notes_stale_actions");
    }
    println!("cargo:rerun-if-env-changed=VITE_ENABLE_NOTES_STALE_ACTIONS");
    println!("cargo:rerun-if-env-changed=LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS");
    tauri_build::build();
}
