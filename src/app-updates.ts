export const UPDATE_CHECK_KEY = "lightwell.update-check.v1";

export const RELEASES_URL = "https://github.com/moonbase2090/lightwell/releases/latest";

export type UpdateDelivery = "integrated" | "manual" | "unavailable";

export interface UpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Automatic checks stay on unless this device stored an explicit off. */
export function parseUpdateCheck(value: string | null): boolean {
  return value !== "off";
}

export function readUpdateCheck(storage: UpdateStorage | null): boolean {
  if (storage === null) return true;
  try {
    return parseUpdateCheck(storage.getItem(UPDATE_CHECK_KEY));
  } catch {
    return true;
  }
}

export function writeUpdateCheck(storage: UpdateStorage | null, enabled: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(UPDATE_CHECK_KEY, enabled ? "on" : "off");
  } catch {
    // The choice still applies for this session.
  }
}

/** The desktop command reports manual or integrated. Anything else still installs. */
export function parseUpdateDelivery(kind: string | null): Exclude<UpdateDelivery, "unavailable"> {
  return kind === "manual" ? "manual" : "integrated";
}

/** Integrated installs can apply the update. Other packages only link to the release. */
export function updateAction(delivery: UpdateDelivery): "install" | "download" | "none" {
  if (delivery === "integrated") return "install";
  if (delivery === "manual") return "download";
  return "none";
}
