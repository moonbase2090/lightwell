fn main() {
    // Match the UI build flag so Mark reviewed / Delete stale IPC exists only when
    // the frontend wires those actions. Both are on unless VITE_ENABLE_NOTES_STALE_ACTIONS
    // is the exact string "false". The frontend reads only that variable, so this gate does
    // too: a second opt-out here would register no commands while the buttons still show.
    println!("cargo:rustc-check-cfg=cfg(lightwell_notes_stale_actions)");
    let enabled = std::env::var("VITE_ENABLE_NOTES_STALE_ACTIONS").as_deref() != Ok("false");
    if enabled {
        println!("cargo:rustc-cfg=lightwell_notes_stale_actions");
    }
    println!("cargo:rerun-if-env-changed=VITE_ENABLE_NOTES_STALE_ACTIONS");
    tauri_build::build();
}
