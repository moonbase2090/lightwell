import prismattycAnnotations from "../../maps/prismattyc.annotations.json";
import prismattycFacts from "../../maps/prismattyc.facts.json";
import scorecardAnnotations from "../../maps/scorecard.annotations.json";
import scorecardFacts from "../../maps/scorecard.facts.json";
import type { MapSource, MapSourceDocument, ProjectNoteInput, ProjectNotesSnapshot, ProjectNotesSource } from "../map-source.js";
import { applyMemoryNoteWrite, noteRevision, type MemoryNote } from "../notes-reload.js";

interface FixtureMap extends MapSourceDocument {
  readonly label: string;
}

const fixtures = {
  prismattyc: {
    label: "Prismattyc",
    facts: prismattycFacts,
    annotations: prismattycAnnotations,
  },
  scorecard: {
    label: "Scorecard",
    facts: scorecardFacts,
    annotations: scorecardAnnotations,
  },
} satisfies Readonly<Record<string, FixtureMap>>;

const fixturesById: ReadonlyMap<string, FixtureMap> = new Map(Object.entries(fixtures));
const entries = [...fixturesById].map(([id, fixture]) => ({ id, label: fixture.label }));

/**
 * Browser-preview notes kept in memory so the notes UI can be exercised without the desktop app.
 * Follows the same VITE_ENABLE_PROJECT_NOTES opt-out as the desktop app.
 */
const PREVIEW_NOTE_AUTHOR = "preview";
const PREVIEW_NOTE_UPDATED_AT = "2026-10-25T03:00:00Z";

export function createMemoryNotesSource(): ProjectNotesSource {
  const compareRevisions = typeof import.meta.env !== "undefined" && import.meta.env.VITE_ENABLE_NOTES_CAS === "true";
  const notesByWorkspace = new Map<string, Map<string, MemoryNote | string>>();
  const snapshot = (workspaceId: string): ProjectNotesSnapshot => ({
    kind: "ready",
    notes: [...(notesByWorkspace.get(workspaceId) ?? new Map<string, MemoryNote | string>())]
      .map(([blockId, stored]) => {
        if (typeof stored === "string") {
          return {
            blockId,
            text: stored,
            sourceFingerprint: "preview",
            author: PREVIEW_NOTE_AUTHOR,
            updatedAt: PREVIEW_NOTE_UPDATED_AT,
            stale: false,
          };
        }
        return {
          blockId,
          text: stored.text,
          sourceFingerprint: stored.sourceFingerprint,
          author: PREVIEW_NOTE_AUTHOR,
          updatedAt: PREVIEW_NOTE_UPDATED_AT,
          stale: false,
          revision: stored.revision,
        };
      }),
  });
  const notesFor = (workspaceId: string) => {
    const existing = notesByWorkspace.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = new Map<string, MemoryNote | string>();
    notesByWorkspace.set(workspaceId, created);
    return created;
  };
  const writeCompared = async (mode: "add" | "edit", input: ProjectNoteInput) => {
    const notes = notesFor(input.workspaceId);
    const current = notes.get(input.blockId);
    const existing = typeof current === "object" ? current : undefined;
    if (mode === "add" && current !== undefined && input.expectation !== "absent" && input.expectation !== "matchesRevision") {
      throw new Error("This block already has a note.");
    }
    if (mode === "edit" && current === undefined && input.expectation !== "absent" && input.expectation !== "matchesRevision") {
      throw new Error("This block has no note to edit.");
    }
    const written = await applyMemoryNoteWrite(
      input.blockId,
      existing,
      input.text,
      "preview",
      input.expectation,
      input.expectedRevision,
    );
    if (!written.ok) {
      throw Object.assign(new Error("This note changed on disk."), written.conflict);
    }
    notes.set(input.blockId, written.note);
    return snapshot(input.workspaceId);
  };
  return {
    async add(input) {
      if (compareRevisions) return writeCompared("add", input);
      const notes = notesFor(input.workspaceId);
      if (notes.has(input.blockId)) throw new Error("This block already has a note.");
      notes.set(input.blockId, input.text);
      return snapshot(input.workspaceId);
    },
    async edit(input) {
      if (compareRevisions) return writeCompared("edit", input);
      const notes = notesFor(input.workspaceId);
      if (!notes.has(input.blockId)) throw new Error("This block has no note to edit.");
      notes.set(input.blockId, input.text);
      return snapshot(input.workspaceId);
    },
    async remove({ workspaceId, blockId }) {
      notesFor(workspaceId).delete(blockId);
      return snapshot(workspaceId);
    },
    ...((typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_NOTES_STALE_ACTIONS) === "true" ? {
      async markReviewed({ workspaceId, blockId }: { workspaceId: string; blockId: string }) {
        const notes = notesFor(workspaceId);
        const existing = notes.get(blockId);
        if (existing === undefined) throw new Error("This block has no note to review.");
        const text = typeof existing === "string" ? existing : existing.text;
        notes.set(blockId, { text, sourceFingerprint: "preview", revision: await noteRevision(text, "preview") });
        return snapshot(workspaceId);
      },
      // The preview store never marks a note stale, so there is nothing to remove.
      async removeStale({ workspaceId }: { workspaceId: string }) {
        return snapshot(workspaceId);
      },
    } : {}),
  };
}

const projectNotesBuildOff =
  (typeof import.meta.env === "undefined" ? undefined : import.meta.env.VITE_ENABLE_PROJECT_NOTES) === "false";
const previewNotes = projectNotesBuildOff ? undefined : createMemoryNotesSource();

export const fixtureMapSource: MapSource = {
  ...(previewNotes === undefined ? {} : { projectNotes: previewNotes }),
  async listMaps() {
    return entries;
  },
  async loadMap(id) {
    const fixture = fixturesById.get(id);
    if (fixture === undefined) {
      throw new Error(`Map \"${id}\" is not available in the browser preview.`);
    }
    return { facts: fixture.facts, annotations: fixture.annotations };
  },
};
