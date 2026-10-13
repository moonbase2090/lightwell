import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { MapSource, ProjectNoteInput, ProjectNotesSource } from "../map-source.js";
import {
  parseEditorSettings,
  parseEditorTemplatePresets,
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
  parseProjectNotesSnapshot,
  parseSourceFileDocument,
  parseWorkspaceMapUpdate,
} from "./tauri-types.js";
import { projectNotesEnabled } from "../feature-flags.js";

const projectNotesApi: ProjectNotesSource = {
  add(input: ProjectNoteInput) {
    return invoke<unknown>("add_workspace_note", {
      path: input.workspaceId,
      blockId: input.blockId,
      text: input.text,
    }).then(parseProjectNotesSnapshot);
  },
  edit(input: ProjectNoteInput) {
    return invoke<unknown>("edit_workspace_note", {
      path: input.workspaceId,
      blockId: input.blockId,
      text: input.text,
    }).then(parseProjectNotesSnapshot);
  },
  remove(input: Omit<ProjectNoteInput, "text">) {
    return invoke<unknown>("remove_workspace_note", {
      path: input.workspaceId,
      blockId: input.blockId,
    }).then(parseProjectNotesSnapshot);
  },
};

export const tauriMapSource: MapSource = {
  editor: {
    inspectBlock(workspaceId, blockId) {
      return invoke<unknown>("inspect_block", {
        workspacePath: workspaceId,
        blockId,
      }).then(parseSourceFileDocument);
    },
    openBlock(workspaceId, blockId) {
      return invoke<void>("open_block_in_editor", {
        workspacePath: workspaceId,
        blockId,
      });
    },
    loadSettings() {
      return invoke<unknown>("load_editor_settings").then(parseEditorSettings);
    },
    saveSettings(settings) {
      return invoke<unknown>("save_editor_settings", { settings }).then(parseEditorSettings);
    },
    listPresets() {
      return invoke<unknown>("editor_template_presets").then(parseEditorTemplatePresets);
    },
  },
  listMaps() {
    return invoke<unknown>("recent_workspaces").then(parseMapSourceEntries);
  },
  loadMap(id) {
    return invoke<unknown>("load_workspace_map", { path: id }).then(parseMapSourceDocument);
  },
  async openWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open a Rust workspace",
    });
    if (selected === null || Array.isArray(selected)) return null;
    const result = await invoke<unknown>("open_workspace", { path: selected });
    return parseMapSourceEntry(result);
  },
  async watchMap(id, onChange, onError) {
    let commandFinished = false;
    let pendingUpdate: ReturnType<typeof parseWorkspaceMapUpdate> | undefined;
    const unlisten = await listen<unknown>("workspace-map-changed", (event) => {
      try {
        const update = parseWorkspaceMapUpdate(event.payload);
        if (update.workspaceId !== id) return;
        if (commandFinished) onChange(update.document);
        else pendingUpdate = update;
      } catch (error: unknown) {
        onError(error);
      }
    });

    try {
      const initial = await invoke<unknown>("watch_workspace", { path: id });
      onChange(parseMapSourceDocument(initial));
      commandFinished = true;
      if (pendingUpdate !== undefined) onChange(pendingUpdate.document);
      return unlisten;
    } catch (error: unknown) {
      unlisten();
      throw error;
    }
  },
  ...(projectNotesEnabled(import.meta.env.VITE_ENABLE_PROJECT_NOTES) ? { projectNotes: projectNotesApi } : {}),
};
