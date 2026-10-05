import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { MapSource } from "../map-source.js";
import {
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
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
};
