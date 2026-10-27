import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const MAP_POPOUT_LABEL = "map-popout";
export const MAP_POPOUT_SYNC_EVENT = "lightwell-map-popout-sync";

const MAP_POPOUT_TITLE = "Lightwell Map";
const MAP_POPOUT_BACKGROUND = "#0A1628";

export interface MapPopoutSync {
  readonly workspaceId: string;
  readonly selectedId: string;
  readonly scopePath: readonly string[];
  readonly mapView: "modules" | "files";
  readonly orientation: "vertical" | "horizontal";
  readonly fileScope: string;
  readonly notesRevision: number;
  readonly revision: number;
}

function popoutSearchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function isSyncRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseMapPopoutSync(payload: unknown): MapPopoutSync {
  if (!isSyncRecord(payload)) throw new Error("Map pop-out sync payload must be an object.");
  const { workspaceId, selectedId, scopePath, mapView, orientation, fileScope, notesRevision, revision } = payload;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("Map pop-out sync workspaceId must be a non-empty string.");
  }
  if (typeof selectedId !== "string") throw new Error("Map pop-out sync selectedId must be a string.");
  if (!isStringArray(scopePath)) throw new Error("Map pop-out sync scopePath must be an array of strings.");
  if (mapView !== "modules" && mapView !== "files") {
    throw new Error("Map pop-out sync mapView must be modules or files.");
  }
  if (orientation !== "vertical" && orientation !== "horizontal") {
    throw new Error("Map pop-out sync orientation must be vertical or horizontal.");
  }
  if (typeof fileScope !== "string") throw new Error("Map pop-out sync fileScope must be a string.");
  if (!isNonNegativeInteger(notesRevision)) {
    throw new Error("Map pop-out sync notesRevision must be a non-negative integer.");
  }
  if (!isNonNegativeInteger(revision)) {
    throw new Error("Map pop-out sync revision must be a non-negative integer.");
  }
  return {
    workspaceId,
    selectedId,
    scopePath: [...scopePath],
    mapView,
    orientation,
    fileScope,
    notesRevision,
    revision,
  };
}

export function isMapPopoutSearch(search: string): boolean {
  return popoutSearchParams(search).get("map-popout") === "1";
}

export function workspaceFromPopoutSearch(search: string): string | null {
  const workspaceId = popoutSearchParams(search).get("workspace");
  if (workspaceId === null || workspaceId.length === 0) return null;
  return workspaceId;
}

export function mapPopoutShortcut(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m";
}

export async function openMapPopoutWindow(workspaceId: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(MAP_POPOUT_LABEL);
  if (existing !== null) {
    await existing.setTitle(MAP_POPOUT_TITLE);
    await existing.show();
    await existing.setFullscreen(true);
    await existing.setFocus();
    return;
  }
  const params = new URLSearchParams({ "map-popout": "1", workspace: workspaceId });
  const popup = new WebviewWindow(MAP_POPOUT_LABEL, {
    url: `index.html?${params.toString()}`,
    title: MAP_POPOUT_TITLE,
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 640,
    fullscreen: true,
    focus: true,
    resizable: true,
    backgroundColor: MAP_POPOUT_BACKGROUND,
  });
  await new Promise<void>((resolve, reject) => {
    void popup.once("tauri://created", () => resolve());
    void popup.once("tauri://error", (event) => {
      const reason: unknown = event.payload;
      if (reason instanceof Error) {
        reject(reason);
        return;
      }
      reject(new Error(typeof reason === "string" && reason.length > 0 ? reason : "Could not open the map window."));
    });
  });
}

export async function closeMapPopoutWindow(): Promise<void> {
  const current = getCurrentWindow();
  if (current.label === MAP_POPOUT_LABEL) {
    await current.close();
    return;
  }
  const existing = await WebviewWindow.getByLabel(MAP_POPOUT_LABEL);
  if (existing !== null) await existing.close();
}

export async function emitMapPopoutSync(payload: MapPopoutSync): Promise<void> {
  if (!isTauri()) return;
  await emit(MAP_POPOUT_SYNC_EVENT, payload);
}

export async function listenMapPopoutSync(
  handler: (payload: MapPopoutSync) => void,
): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  return listen(MAP_POPOUT_SYNC_EVENT, (event) => {
    handler(parseMapPopoutSync(event.payload));
  });
}
