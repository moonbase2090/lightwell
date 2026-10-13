export type ThemePreference = "system" | "dark" | "light" | "blueprint";
export type ResolvedTheme = "dark" | "light" | "blueprint";

const THEME_PREFERENCE_KEY = "lightwell.theme";

/** Theme for new installs and unset or unreadable preferences. A saved preference always wins. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "blueprint";

export function isThemePreference(value: string | null): value is ThemePreference {
  switch (value) {
    case "system":
    case "dark":
    case "light":
    case "blueprint":
      return true;
    default:
      return false;
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // Theme changes still apply for this session when browser storage is unavailable.
  }
}

export function resolveTheme(preference: ThemePreference, systemTheme: "dark" | "light"): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}
