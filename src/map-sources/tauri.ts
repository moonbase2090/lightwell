import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { MapHistorySource, MapSource, ProjectNoteInput, ProjectNotesSource } from "../map-source.js";
import type { LanguagePackSource } from "../language-pack-source.js";
import {
  parseBlockDiffDocument,
  parseCommitChanges,
  parseCommitSummaries,
  parseResolvedCommitRange,
  parseEditorSettings,
  parseEditorTemplatePresets,
  parseMapSourceDocument,
  parseMapSourceEntries,
  parseMapSourceEntry,
  parseProjectNotesSnapshot,
  parseNotesGitStatus,
  parseNoteCommitResult,
  parseSourceFileDocument,
  parseWorkspaceMapUpdate,
  parseWorkspaceNotesUpdate,
  parseLanguagePackCatalog,
} from "./tauri-types.js";
import { readNoteRevisionConflict } from "../notes-reload.js";

function notesCasFlagEnabled(): boolean {
  return typeof import.meta.env !== "undefined" && import.meta.env.VITE_ENABLE_NOTES_CAS === "true";
}

export function noteCommandArgs(input: Pick<ProjectNoteInput, "expectedRevision" | "expectation">, enabled = notesCasFlagEnabled()): { expectedRevision?: string | null; expectation?: ProjectNoteInput["expectation"] | null } {
  if (!enabled) return {};
  return {
    expectedRevision: input.expectedRevision ?? null,
    expectation: input.expectation ?? null,
  };
}

export function removeNoteArgs(input: Omit<ProjectNoteInput, "text">, enabled = notesCasFlagEnabled()) {
  return {
    path: input.workspaceId,
    blockId: input.blockId,
    ...noteCommandArgs(input, enabled),
  };
}

function rejectNoteCommand(cause: unknown): never {
  const conflict = readNoteRevisionConflict(cause);
  if (conflict !== null) {
    throw Object.assign(new Error("This note changed on disk."), conflict);
  }
  if (typeof cause === "string" && cause.length > 0) throw new Error(cause);
  if (cause instanceof Error) throw cause;
  throw new Error("Could not save this project note.");
}

const projectNotesApi: ProjectNotesSource = {
  ...((typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_NOTE_GIT) === "true" ? { git: {
    status(input) {
      return invoke<unknown>("project_notes_git_status", { path: input.workspaceId, blockId: input.blockId }).then(parseNotesGitStatus);
    },
    commit(input) {
      return invoke<unknown>("commit_workspace_note", {
        path: input.workspaceId, blockId: input.blockId, revision: input.revision,
        text: input.text, sourceFingerprint: input.sourceFingerprint,
      }).then(parseNoteCommitResult);
    },
  } } : {}),
  add(input: ProjectNoteInput) {
    return invoke<unknown>("add_workspace_note", {
      path: input.workspaceId,
      blockId: input.blockId,
      text: input.text,
      ...noteCommandArgs(input),
    }).then(parseProjectNotesSnapshot, rejectNoteCommand);
  },
  edit(input: ProjectNoteInput) {
    return invoke<unknown>("edit_workspace_note", {
      path: input.workspaceId,
      blockId: input.blockId,
      text: input.text,
      ...noteCommandArgs(input),
    }).then(parseProjectNotesSnapshot, rejectNoteCommand);
  },
  remove(input: Omit<ProjectNoteInput, "text">) {
    return invoke<unknown>("remove_workspace_note", removeNoteArgs(input)).then(parseProjectNotesSnapshot, rejectNoteCommand);
  },
  ...((typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_NOTES_STALE_ACTIONS) === "true" ? {
    markReviewed(input: Omit<ProjectNoteInput, "text">) {
      return invoke<unknown>("mark_workspace_note_reviewed", {
        path: input.workspaceId,
        blockId: input.blockId,
      }).then(parseProjectNotesSnapshot);
    },
    removeStale(input: { readonly workspaceId: string }) {
      return invoke<unknown>("remove_stale_workspace_notes", {
        path: input.workspaceId,
      }).then(parseProjectNotesSnapshot);
    },
  } : {}),
};

const historyApi: MapHistorySource = {
  resolveRange(workspaceId, through, preset) {
    return invoke<unknown>("workspace_commit_range", { path: workspaceId, through, preset }).then(parseResolvedCommitRange);
  },
  listCommits(workspaceId) {
    return invoke<unknown>("recent_workspace_commits", { path: workspaceId }).then(parseCommitSummaries);
  },
  listSinceCommits(workspaceId, throughCommitId) {
    return invoke<unknown>("workspace_since_commits", { path: workspaceId, through: throughCommitId }).then(parseCommitSummaries);
  },
  commitChanges(workspaceId, commitId, baseCommitId = null) {
    return invoke<unknown>("workspace_commit_changes", {
      path: workspaceId,
      commit: commitId,
      baseCommit: baseCommitId,
    }).then(parseCommitChanges);
  },
  blockDiff(workspaceId, commitId, blockId, baseCommitId = null) {
    return invoke<unknown>("workspace_block_diff", {
      path: workspaceId,
      commit: commitId,
      blockId,
      baseCommit: baseCommitId,
    }).then(parseBlockDiffDocument);
  },
  fileDiff(workspaceId, commitId, filePath, baseCommitId = null) {
    return invoke<unknown>("workspace_path_diff", {
      path: workspaceId,
      commit: commitId,
      filePath,
      baseCommit: baseCommitId,
    }).then(parseBlockDiffDocument);
  },
};

const languagePacksApi: LanguagePackSource = {
  catalog(workspaceId) {
    return invoke<unknown>("language_pack_catalog", { workspaceId }).then(parseLanguagePackCatalog);
  },
  install(source, replace, workspaceId) {
    return invoke<unknown>("install_language_pack", { source, replace, workspaceId }).then(parseLanguagePackCatalog);
  },
  reload(workspaceId) {
    return invoke<unknown>("reload_language_packs", { workspaceId }).then(parseLanguagePackCatalog);
  },
  remove(id, workspaceId) {
    return invoke<unknown>("remove_language_pack", { id, workspaceId }).then(parseLanguagePackCatalog);
  },
  openDirectory() {
    return invoke<void>("open_language_packs_directory");
  },
  async watch(onChange, onError) {
    return listen<unknown>("language-pack-catalog-changed", (event) => {
      try {
        onChange(parseLanguagePackCatalog(event.payload));
      } catch (error: unknown) {
        onError(error);
      }
    });
  },
};

export const tauriMapSource: MapSource = {
  ...((typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_LANGUAGE_PACKS) === "true"
    ? { languagePacks: languagePacksApi }
    : {}),
  editor: {
    inspectBlock(workspaceId, blockId) {
      return invoke<unknown>("inspect_block", {
        workspacePath: workspaceId,
        blockId,
      }).then(parseSourceFileDocument);
    },
    openBlock(workspaceId, blockId) {
      return invoke<void>("open_block_in_editor", {
        workspacePath: workspaceId,
        blockId,
      });
    },
    loadSettings() {
      return invoke<unknown>("load_editor_settings").then(parseEditorSettings);
    },
    saveSettings(settings) {
      return invoke<unknown>("save_editor_settings", { settings }).then(parseEditorSettings);
    },
    listPresets() {
      return invoke<unknown>("editor_template_presets").then(parseEditorTemplatePresets);
    },
  },
  listMaps() {
    return invoke<unknown>("recent_workspaces").then(parseMapSourceEntries);
  },
  loadMap(id) {
    return invoke<unknown>("load_workspace_map", { path: id }).then(parseMapSourceDocument);
  },
  async openWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open a project folder",
    });
    if (selected === null || Array.isArray(selected)) return null;
    const result = await invoke<unknown>("open_workspace", { path: selected });
    return parseMapSourceEntry(result);
  },
  async watchMap(id, onChange, onError, onNotes) {
    let commandFinished = false;
    let pendingUpdate: ReturnType<typeof parseWorkspaceMapUpdate> | undefined;
    const unlistenNotes = typeof import.meta.env !== "undefined" && import.meta.env.VITE_ENABLE_NOTES_CAS === "true" && onNotes !== undefined
      ? await listen<unknown>("workspace-notes-changed", (event) => {
          try {
            const update = parseWorkspaceNotesUpdate(event.payload);
            if (update.path !== id) return;
            onNotes(update.projectNotes);
          } catch (error: unknown) {
            onError(error);
          }
        })
      : () => undefined;
    const unlistenMap = await listen<unknown>("workspace-map-changed", (event) => {
      try {
        const update = parseWorkspaceMapUpdate(event.payload);
        if (update.workspaceId !== id) return;
        if (commandFinished) onChange(update.document);
        else pendingUpdate = update;
      } catch (error: unknown) {
        onError(error);
      }
    });

    try {
      const initial = await invoke<unknown>("watch_workspace", { path: id });
      onChange(parseMapSourceDocument(initial));
      commandFinished = true;
      if (pendingUpdate !== undefined) onChange(pendingUpdate.document);
      return () => {
        unlistenMap();
        unlistenNotes();
      };
    } catch (error: unknown) {
      unlistenMap();
      unlistenNotes();
      throw error;
    }
  },
  ...((typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_PROJECT_NOTES) === "false"
    ? {}
    : { projectNotes: projectNotesApi }),
  ...((typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_COMMIT_DIFF) === "false"
    ? {}
    : { history: historyApi }),
};
