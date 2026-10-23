/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PROJECT_NOTES?: string;
  readonly VITE_ENABLE_NOTE_GIT?: string;
  readonly VITE_ENABLE_COMMIT_DIFF?: string;
}
