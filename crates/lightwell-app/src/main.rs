#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;
mod workspace;

fn main() {
    tauri::Builder::default()
        .manage(workspace::WorkspaceWatchers::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            updates::update_delivery,
            workspace::recent_workspaces,
            workspace::open_workspace,
            workspace::load_workspace_map,
            workspace::watch_workspace,
            workspace::add_workspace_note,
            workspace::edit_workspace_note,
            workspace::remove_workspace_note,
            workspace::inspect_block,
            workspace::open_block_in_editor,
            workspace::load_editor_settings,
            workspace::save_editor_settings,
            workspace::editor_template_presets,
            workspace::recent_workspace_commits,
            workspace::workspace_since_commits,
            workspace::workspace_commit_changes,
            workspace::workspace_block_diff,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Lightwell desktop app");
}
