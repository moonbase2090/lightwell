/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PROJECT_NOTES?: string;
  readonly VITE_ENABLE_NOTE_GIT?: string;
  readonly VITE_ENABLE_NOTES_STALE_ACTIONS?: string;
  readonly VITE_ENABLE_COMMIT_DIFF?: string;
  readonly VITE_ENABLE_MAP_POPOUT?: string;
}
