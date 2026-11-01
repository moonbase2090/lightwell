import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BlockDiffDocument, CommitChanges, CommitSummary, ResolvedCommitRange } from "../src/map-source.js";

// ---------------------------------------------------------------------------
// Console / pageerror gate
// ---------------------------------------------------------------------------
// Every spec goes through this fixture. Any console `error` message or
// uncaught page error fails the test at teardown.
//
// Allowlist: intentionally EMPTY. No benign console errors were observed in
// the fixture or mocked builds. Add an entry only with a comment naming the
// exact message and why it is benign.
const CONSOLE_ERROR_ALLOWLIST: readonly RegExp[] = [];

export const test = base.extend<{ consoleGate: void }>({
  consoleGate: [
    async ({ page }, use) => {
      const failures: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (CONSOLE_ERROR_ALLOWLIST.some((re) => re.test(text))) return;
        failures.push(`console.error: ${text}`);
      });
      page.on("pageerror", (err) => {
        const text = String(err);
        if (CONSOLE_ERROR_ALLOWLIST.some((re) => re.test(text))) return;
        failures.push(`pageerror: ${text}`);
      });
      await use();
      expect(failures, `console/page errors during test:\n${failures.join("\n")}`).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

// ---------------------------------------------------------------------------
// Web (fixture) navigation
// ---------------------------------------------------------------------------
export async function gotoWeb(page: Page): Promise<void> {
  await page.goto("/");
  // The fixture build always offers Prismattyc and Scorecard.
  await expect(page.getByLabel("Project summary")).toBeVisible();
}

// ---------------------------------------------------------------------------
// IPC (mocked Tauri) navigation
// ---------------------------------------------------------------------------
// Captures come from e2e/fixtures/captures.json (real lightwell-core output;
// see e2e/README.md). The invoke handler replicates the mechanism of
// `mockIPC` from @tauri-apps/api/mocks (v2.12): it installs
// `window.__TAURI_INTERNALS__.invoke` before any app script runs via
// addInitScript, so `isTauri()` is true and src/main.tsx picks the desktop
// (Tauri) map source. Commands are answered from the captures.
const CAPTURES_JSON = readFileSync(
  fileURLToPath(new URL("./fixtures/captures.json", import.meta.url)),
  "utf8",
);

export async function gotoIpc(page: Page, overrides: {
  readonly changes?: CommitChanges;
  readonly commits?: readonly CommitSummary[];
  readonly ranges?: Readonly<Record<string, ResolvedCommitRange | string>>;
  readonly diff?: BlockDiffDocument;
} = {}): Promise<void> {
  await page.route("**/__lw-captures.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...JSON.parse(CAPTURES_JSON), ...overrides }) }),
  );
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (data: unknown) => void>();
    let capsPromise: Promise<Record<string, unknown>> | undefined;
    const loadCaps = () => {
      capsPromise ??= fetch("/__lw-captures.json").then((r) => r.json());
      return capsPromise;
    };
    const notesState: { notes: { blockId: string; text: string; sourceFingerprint: string; author: string; updatedAt: string; stale: boolean }[] } = {
      notes: [],
    };
    // Revision the mock hands out: a note's text and fingerprint, so a changed note has a new revision.
    const noteRevisionOf = (note: { blockId: string; text: string; sourceFingerprint: string }) =>
      `rev:${note.blockId}:${note.sourceFingerprint}:${note.text}`;
    const snapshot = () => ({ kind: "ready", notes: notesState.notes.map((note) => ({ ...note, revision: noteRevisionOf(note) })) });
    // Test hook: change the first note on "disk" after the dialog has loaded it, as another process would.
    w.__LW_NOTE_DISK_EDIT__ = (text: string) => {
      if (notesState.notes[0]) notesState.notes[0].text = text;
    };
    const committedNotes = new Map<string, string>();
    let notesRevision = 0;
    let languagePackRevision = 1;
    let languagePackEntries: Array<Record<string, unknown>> = [{
      kind: "loaded",
      id: "rust",
      packVersion: "1.0.0",
      origin: "builtin",
      manifestPath: null,
      manifest: {
        schemaVersion: 1,
        id: "rust",
        packVersion: "1.0.0",
        extensions: [".rs"],
        basenames: ["Cargo.toml"],
        basenamePrefixes: [],
        monaco: { id: "rust", highlighter: "rust", byExtension: {}, byBasename: {}, byBasenamePrefix: {} },
        extractors: { source: "rust-workspace", workspace: "rust" },
        fixtures: null,
      },
    }];
    const languagePackSnapshot = () => ({
      revision: languagePackRevision,
      userPacksDirectory: "/redacted/language-packs",
      entries: languagePackEntries,
    });
    const gitStatus = (blockId: string) => {
      if (typeof w.__LW_NOTES_GIT_STATE__ === "string") return { kind: w.__LW_NOTES_GIT_STATE__ };
      return { kind: "ready", state: "modified", revision: `saved-revision-${notesRevision}`, noteChanged: committedNotes.get(blockId) !== notesState.notes.find((note) => note.blockId === blockId)?.text };
    };

    async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
      const caps = (await loadCaps()) as {
        workspaces: { id: string; label: string }[];
        maps: Record<string, unknown>;
        sources: Record<string, unknown>;
        commits: { id: string }[];
        ranges?: Record<string, unknown>;
        changes: unknown;
        diff: unknown;
        presets: unknown[];
        fixturePath: string;
      };
      switch (cmd) {
        case "recent_workspaces":
          return caps.workspaces;
        case "load_workspace_map":
        case "watch_workspace": {
          const doc = caps.maps[String(args.path ?? args.workspacePath ?? "")];
          if (!doc) throw new Error(`unknown workspace ${String(args.path)}`);
          return doc;
        }
        case "open_workspace":
          return caps.workspaces[0];
        case "inspect_block": {
          const doc = caps.sources[String(args.blockId)];
          if (!doc) throw new Error(`no source for block ${String(args.blockId)}`);
          return doc;
        }
        case "open_block_in_editor":
          if ((globalThis as Record<string, unknown>).__LW_FAIL_EDITOR__) {
            throw new Error("mock editor launch failure");
          }
          return undefined;
        case "load_editor_settings":
          return { commandTemplate: null };
        case "save_editor_settings":
          return args.settings ?? { commandTemplate: null };
        case "editor_template_presets":
          return caps.presets;
        case "language_pack_catalog":
        case "reload_language_packs":
          return languagePackSnapshot();
        case "install_language_pack": {
          const source = args.source;
          if (typeof source !== "object" || source === null || !("kind" in source) || !("id" in source)
            || source.kind !== "catalog" || source.id !== "demo" || args.replace !== false
            || args.workspaceId !== "workspace:prismattyc") {
            throw new Error("Invalid captured language pack install request");
          }
          w.__LW_LANGUAGE_PACK_INSTALL_INPUT__ = args;
          languagePackRevision += 1;
          languagePackEntries = [...languagePackEntries, {
            kind: "loaded",
            id: "demo",
            packVersion: "1.0.0",
            origin: "user",
            manifestPath: "/redacted/language-packs/demo/language-pack.json",
            manifest: {
              schemaVersion: 1,
              id: "demo",
              packVersion: "1.0.0",
              extensions: [".demo"],
              basenames: ["DemoFile"],
              basenamePrefixes: [],
              monaco: { id: "plaintext", highlighter: null, byExtension: {}, byBasename: {}, byBasenamePrefix: {} },
              extractors: { source: null, workspace: null },
              fixtures: null,
            },
          }];
          return languagePackSnapshot();
        }
        case "remove_language_pack":
          languagePackRevision += 1;
          languagePackEntries = languagePackEntries.filter((entry) => entry.id !== args.id || entry.origin !== "user");
          return languagePackSnapshot();
        case "open_language_packs_directory":
          return undefined;
        case "add_workspace_note":
        case "edit_workspace_note": {
          notesRevision += 1;
          const blockId = String(args.blockId);
          const text = String(args.text ?? "");
          const existing = notesState.notes.find((n) => n.blockId === blockId);
          if (existing) existing.text = text;
          else notesState.notes.push({ blockId, text, sourceFingerprint: "capture", author: "preview", updatedAt: "2026-10-25T03:00:00Z", stale: false });
          return snapshot();
        }
        case "project_notes_git_status":
          return gitStatus(String(args.blockId));
        case "commit_workspace_note": {
          if (w.__LW_FAIL_NOTE_COMMIT__) throw new Error("Signing failed. Configure Git signing and retry.");
          if (args.revision !== `saved-revision-${notesRevision}`) throw new Error("Notes changed since the last refresh.");
          const blockId = String(args.blockId);
          committedNotes.set(blockId, String(args.text));
          w.__LW_NOTE_COMMIT_INPUT__ = args;
          return { commitId: "1234567890abcdef1234567890abcdef12345678", status: gitStatus(blockId) };
        }
        case "remove_workspace_note": {
          const blockId = String(args.blockId);
          const current = notesState.notes.find((n) => n.blockId === blockId);
          if (args.expectation === "matchesRevision" && typeof args.expectedRevision === "string") {
            if (!current) throw { kind: "revisionConflict", blockId, current: { kind: "deleted" } };
            const revision = noteRevisionOf(current);
            if (revision !== args.expectedRevision) {
              throw {
                kind: "revisionConflict",
                blockId,
                current: { kind: "present", text: current.text, sourceFingerprint: current.sourceFingerprint, revision },
              };
            }
          }
          notesState.notes = notesState.notes.filter((n) => n.blockId !== blockId);
          return snapshot();
        }
        case "recent_workspace_commits":
          return caps.commits;
        case "workspace_since_commits":
          return caps.commits.filter((commit) => commit.id !== args.through);
        case "workspace_commit_range": {
          w.__LW_RANGE_INPUT__ = args;
          if (typeof args.preset !== "object" || args.preset === null || !("kind" in args.preset)) {
            throw new Error("Invalid captured range request");
          }
          const kind = args.preset.kind;
          if (typeof kind !== "string") throw new Error("Invalid captured range request");
          const response = caps.ranges?.[kind];
          if (typeof response === "string") throw new Error(response);
          if (response) return response;
          if (typeof caps.changes !== "object" || caps.changes === null || !("commit" in caps.changes)) throw new Error("Missing captured commit");
          const changes = caps.changes;
          return { commit: changes.commit, baseCommit: null, commitCount: 1, releaseTag: null };
        }
        case "workspace_commit_changes":
          w.__LW_RANGE_DIFF_INPUT__ = args;
          return caps.changes;
        case "workspace_block_diff":
        case "workspace_path_diff":
          return caps.diff;
        case "update_delivery":
          return "manual";
        case "plugin:dialog|open":
          return caps.fixturePath;
        case "plugin:event|listen":
          // Mirror mockIPC: the listen call resolves to the handler id.
          return args.handler;
        case "plugin:event|emit":
        case "plugin:event|emit_to":
          return undefined;
        case "plugin:event|unlisten":
          return undefined;
        case "plugin:updater|check":
          return null;
        default:
          // Unknown plugin commands (window, webview, etc.) resolve empty
          // rather than crashing the shell under test.
          return undefined;
      }
    }

    // isTauri() in @tauri-apps/api/core reads the `isTauri` window global,
    // not __TAURI_INTERNALS__; without it main.tsx picks the fixture source
    // and every desktop-only path (editor, history, settings) stays absent.
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => handle(cmd, args ?? {}),
      transformCallback: (callback: (data: unknown) => void) => {
        const id = callbacks.size + 1;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
    };
    // _unlisten in @tauri-apps/api/event calls this before the IPC unlisten.
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };
  });
  await page.goto("/");
  await expect(page.getByLabel("Project summary")).toBeVisible();
}
