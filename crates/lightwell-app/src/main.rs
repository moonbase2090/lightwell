#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod language_packs;
#[cfg(any(target_os = "macos", all(test, unix)))]
mod path_shim;
mod updates;
mod workspace;

fn main() {
    let builder = tauri::Builder::default()
        .manage(workspace::WorkspaceWatchers::default())
        .manage(language_packs::LanguagePackService::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            if let Err(error) = path_shim::ensure_current_app() {
                eprintln!("lightwell: warning: {error}");
            }
            Ok(())
        });

    // Stale-note actions are registered only when the app was built with
    // VITE_ENABLE_NOTES_STALE_ACTIONS=true (or LIGHTWELL_ENABLE_NOTES_STALE_ACTIONS=true).
    // Keep both handler lists in sync except for those two commands.
    #[cfg(lightwell_notes_stale_actions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        updates::update_delivery,
        language_packs::language_pack_catalog,
        language_packs::validate_language_pack,
        language_packs::install_language_pack,
        language_packs::reload_language_packs,
        language_packs::remove_language_pack,
        language_packs::open_language_packs_directory,
        workspace::recent_workspaces,
        workspace::open_workspace,
        workspace::load_workspace_map,
        workspace::watch_workspace,
        workspace::add_workspace_note,
        workspace::edit_workspace_note,
        workspace::remove_workspace_note,
        workspace::mark_workspace_note_reviewed,
        workspace::remove_stale_workspace_notes,
        workspace::project_notes_git_status,
        workspace::commit_workspace_note,
        workspace::inspect_block,
        workspace::open_block_in_editor,
        workspace::load_editor_settings,
        workspace::save_editor_settings,
        workspace::editor_template_presets,
        workspace::recent_workspace_commits,
        workspace::workspace_since_commits,
        workspace::workspace_commit_range,
        workspace::workspace_commit_changes,
        workspace::workspace_block_diff,
        workspace::workspace_path_diff,
    ]);
    #[cfg(not(lightwell_notes_stale_actions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        updates::update_delivery,
        language_packs::language_pack_catalog,
        language_packs::validate_language_pack,
        language_packs::install_language_pack,
        language_packs::reload_language_packs,
        language_packs::remove_language_pack,
        language_packs::open_language_packs_directory,
        workspace::recent_workspaces,
        workspace::open_workspace,
        workspace::load_workspace_map,
        workspace::watch_workspace,
        workspace::add_workspace_note,
        workspace::edit_workspace_note,
        workspace::remove_workspace_note,
        workspace::project_notes_git_status,
        workspace::commit_workspace_note,
        workspace::inspect_block,
        workspace::open_block_in_editor,
        workspace::load_editor_settings,
        workspace::save_editor_settings,
        workspace::editor_template_presets,
        workspace::recent_workspace_commits,
        workspace::workspace_since_commits,
        workspace::workspace_commit_range,
        workspace::workspace_commit_changes,
        workspace::workspace_block_diff,
        workspace::workspace_path_diff,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("failed to run Lightwell desktop app");
}
