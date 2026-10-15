const WORD_WRAP_KEY = "lightwell.sourceWordWrap";

/** Word wrap in the read-only source view. Off unless the viewer turned it on. */
export function readWordWrapPreference(): boolean {
  try {
    return window.localStorage.getItem(WORD_WRAP_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveWordWrapPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(WORD_WRAP_KEY, enabled ? "on" : "off");
  } catch {
    // Storage can be unavailable; the toggle still applies for this session.
  }
}
