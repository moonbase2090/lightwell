/**
 * Project notes are on by default. Set VITE_ENABLE_PROJECT_NOTES=false at build time to leave them out.
 */
export function projectNotesEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}
