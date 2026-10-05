#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod workspace;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace::recent_workspaces,
            workspace::open_workspace,
            workspace::load_workspace_map,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Lightwell desktop app");
}
