import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { MapSource } from "../map-source.js";
import {
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
  parseWorkspaceMapUpdate,
} from "./tauri-types.js";

export const tauriMapSource: MapSource = {
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
};
