/**
 * Project notes are on unless the build sets VITE_ENABLE_PROJECT_NOTES to the
 * exact string "false". Call sites compare `import.meta.env.VITE_ENABLE_PROJECT_NOTES`
 * to "false" directly so the bundler can drop the notes branch.
 */
export function projectNotesEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * The compound dependency layout is on unless the build sets VITE_ENABLE_COMPOUND_LAYOUT to
 * the exact string "false". The app compares the env string to "false" directly so the
 * bundler can drop the layout worker.
 */
export function compoundLayoutEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * Source-derived state charts are on unless the build sets VITE_ENABLE_STATE_CHART to the
 * exact string "false". Call sites compare `import.meta.env.VITE_ENABLE_STATE_CHART` to
 * "false" directly so the bundler can drop the state-chart branch.
 */
export function stateChartEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * Mark reviewed and bulk delete of stale notes are on unless the build sets
 * VITE_ENABLE_NOTES_STALE_ACTIONS to the exact string "false".
 *
 * Call sites compare `import.meta.env.VITE_ENABLE_NOTES_STALE_ACTIONS` to
 * `"false"` directly so the bundler can drop the branch. This helper documents and
 * unit-tests the predicate.
 */
export function notesStaleActionsEnabled(value: string | undefined): boolean {
  return value !== "false";
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
 * The map pop-out window is on unless the build sets VITE_ENABLE_MAP_POPOUT
 * to the exact string "false". Call sites compare `import.meta.env.VITE_ENABLE_MAP_POPOUT`
 * to "false" directly so the bundler can drop the pop-out branch.
 */
export function mapPopoutEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * Per-note revision checks are on unless the build sets VITE_ENABLE_NOTES_CAS
 * to the exact string "false". Call sites compare
 * `import.meta.env.VITE_ENABLE_NOTES_CAS !== "false"` directly so the bundler
 * can drop the compare-and-swap branch.
 */
export function notesCasEnabled(value: string | undefined): boolean {
  return value !== "false";
}
