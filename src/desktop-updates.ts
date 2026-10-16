import { invoke } from "@tauri-apps/api/core";
import { parseUpdateDelivery, type UpdateDelivery } from "./app-updates.js";

export interface DesktopUpdate {
  readonly version: string;
  readonly notes: string;
  install(): Promise<void>;
  dismiss(): Promise<void>;
}

export async function desktopUpdateDelivery(): Promise<Exclude<UpdateDelivery, "unavailable">> {
  const kind = await invoke<string>("update_delivery");
  return parseUpdateDelivery(kind);
}

export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  const update = await check();
  if (update === null) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    async install() {
      await update.downloadAndInstall();
      await relaunch();
    },
    async dismiss() {
      await update.close();
    },
  };
}
