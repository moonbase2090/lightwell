const WORD_WRAP_KEY = "lightwell.sourceWordWrap";
const WORD_WRAP_SHORTCUT_KEY = "lightwell.sourceWordWrapShortcut";

/** VS Code's binding. Some programs take Alt+Z globally, so it can be changed or turned off. */
export const DEFAULT_WORD_WRAP_SHORTCUT = "Alt+Z";

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

/** The stored shortcut, "" when turned off, or the default when unset or unreadable. */
export function readWordWrapShortcut(): string {
  try {
    const stored = window.localStorage.getItem(WORD_WRAP_SHORTCUT_KEY);
    if (stored === null) return DEFAULT_WORD_WRAP_SHORTCUT;
    return stored === "" || parseShortcut(stored) !== null ? stored : DEFAULT_WORD_WRAP_SHORTCUT;
  } catch {
    return DEFAULT_WORD_WRAP_SHORTCUT;
  }
}

export function saveWordWrapShortcut(shortcut: string): void {
  try {
    window.localStorage.setItem(WORD_WRAP_SHORTCUT_KEY, shortcut);
  } catch {
    // Storage can be unavailable; the shortcut still applies for this session.
  }
}

export interface Shortcut {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  /** "A"–"Z", "0"–"9", or "F1"–"F12". */
  readonly key: string;
}

const KEY_PATTERN = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-2]))$/;
const isFunctionKey = (key: string) => /^F\d/.test(key);

/** Parse "Ctrl+Shift+W" style text. A letter or digit needs a modifier; F-keys may stand alone. */
export function parseShortcut(text: string): Shortcut | null {
  const parts = text.split("+").map((part) => part.trim());
  const key = parts.pop()?.toUpperCase() ?? "";
  if (!KEY_PATTERN.test(key)) return null;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const name = part.toLowerCase();
    if (!["ctrl", "alt", "shift", "meta"].includes(name) || modifiers.has(name)) return null;
    modifiers.add(name);
  }
  const shortcut = {
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("meta"),
    key,
  };
  const hasModifier = shortcut.ctrl || shortcut.alt || shortcut.meta;
  return hasModifier || isFunctionKey(key) ? shortcut : null;
}

export function formatShortcut(shortcut: Shortcut): string {
  return [
    shortcut.ctrl ? "Ctrl" : "",
    shortcut.alt ? "Alt" : "",
    shortcut.shift ? "Shift" : "",
    shortcut.meta ? "Meta" : "",
    shortcut.key,
  ].filter((part) => part.length > 0).join("+");
}

/**
 * The shortcut a key press records, or null for a lone modifier or an
 * unsupported key. Uses `code`, so Alt+Z records Z even when Alt changes the
 * typed character.
 */
export function shortcutFromKeyEvent(event: {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}): string | null {
  const match = /^(?:Key([A-Z])|Digit([0-9])|(F(?:[1-9]|1[0-2])))$/.exec(event.code);
  if (match === null) return null;
  const key = match[1] ?? match[2] ?? match[3] ?? "";
  const shortcut = parseShortcut(formatShortcut({
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key,
  }));
  return shortcut === null ? null : formatShortcut(shortcut);
}
