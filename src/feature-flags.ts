/**
 * Project notes are on unless the build sets VITE_ENABLE_PROJECT_NOTES to the
 * exact string "false". Call sites compare `import.meta.env.VITE_ENABLE_PROJECT_NOTES`
 * to "false" directly so the bundler can drop the notes branch.
 */
export function projectNotesEnabled(value: string | undefined): boolean {
  return value !== "false";
}

/**
 * The commit diff view is off unless the build sets VITE_ENABLE_COMMIT_DIFF to
 * the exact string "true". Turning it on by default is its own change.
 */
export function commitDiffEnabled(value: string | undefined): boolean {
  return value === "true";
}
