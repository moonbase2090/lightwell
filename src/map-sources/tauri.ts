import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { MapSource, MapSourceDocument, MapSourceEntry } from "../map-source.js";

export const tauriMapSource: MapSource = {
  listMaps() {
    return invoke<readonly MapSourceEntry[]>("recent_workspaces");
  },
  loadMap(id) {
    return invoke<MapSourceDocument>("load_workspace_map", { path: id });
  },
  async openWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open a Rust workspace",
    });
    if (selected === null || Array.isArray(selected)) return null;
    return invoke<MapSourceEntry>("open_workspace", { path: selected });
  },
};
