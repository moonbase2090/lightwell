/**
 * Project notes are on unless the build sets VITE_ENABLE_PROJECT_NOTES to the
 * exact string "false". Call sites compare `import.meta.env.VITE_ENABLE_PROJECT_NOTES`
 * to "false" directly so the bundler can drop the notes branch.
 */
export function projectNotesEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * Mark reviewed and bulk delete of stale notes stay off unless the build sets
 * VITE_ENABLE_NOTES_STALE_ACTIONS to the exact string "true".
 *
 * Call sites compare `import.meta.env.VITE_ENABLE_NOTES_STALE_ACTIONS` to
 * `"true"` directly so the bundler can drop the branch (same pattern as
 * `VITE_ENABLE_NOTE_GIT`). This helper documents and unit-tests the predicate.
 */
export function notesStaleActionsEnabled(value: string | undefined): boolean {
  return value === "true";
}

/**
 * The commit diff view is on unless the build sets VITE_ENABLE_COMMIT_DIFF to
 * the exact string "false". Call sites compare `import.meta.env.VITE_ENABLE_COMMIT_DIFF`
 * to "false" directly so the bundler can drop the history branch.
 */
export function commitDiffEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * The map pop-out window is off unless the build sets VITE_ENABLE_MAP_POPOUT
 * to the exact string "true". Call sites compare `import.meta.env.VITE_ENABLE_MAP_POPOUT`
 * to "true" directly so the bundler can drop the pop-out branch.
 */
export function mapPopoutEnabled(value: string | undefined): boolean {
  return value === "true";
}
