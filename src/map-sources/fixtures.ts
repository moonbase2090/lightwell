import prismattycAnnotations from "../../maps/prismattyc.annotations.json";
import prismattycFacts from "../../maps/prismattyc.facts.json";
import scorecardAnnotations from "../../maps/scorecard.annotations.json";
import scorecardFacts from "../../maps/scorecard.facts.json";
import type { MapSource, MapSourceDocument, ProjectNotesSnapshot, ProjectNotesSource } from "../map-source.js";

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
  const notesByWorkspace = new Map<string, Map<string, { text: string; sourceFingerprint: string; stale: boolean }>>();
  const snapshot = (workspaceId: string): ProjectNotesSnapshot => ({
    kind: "ready",
    notes: [...(notesByWorkspace.get(workspaceId) ?? new Map())]
      .map(([blockId, note]) => ({
        blockId,
        text: note.text,
        sourceFingerprint: note.sourceFingerprint,
        stale: note.stale,
        author: PREVIEW_NOTE_AUTHOR,
        updatedAt: PREVIEW_NOTE_UPDATED_AT,
      })),
  });
  const notesFor = (workspaceId: string) => {
    const existing = notesByWorkspace.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = new Map<string, { text: string; sourceFingerprint: string; stale: boolean }>();
    notesByWorkspace.set(workspaceId, created);
    return created;
  };
  return {
    async add({ workspaceId, blockId, text }) {
      const notes = notesFor(workspaceId);
      if (notes.has(blockId)) throw new Error("This block already has a note.");
      notes.set(blockId, { text, sourceFingerprint: "preview", stale: false });
      return snapshot(workspaceId);
    },
    async edit({ workspaceId, blockId, text }) {
      const notes = notesFor(workspaceId);
      const existing = notes.get(blockId);
      if (existing === undefined) throw new Error("This block has no note to edit.");
      notes.set(blockId, { ...existing, text });
      return snapshot(workspaceId);
    },
    async remove({ workspaceId, blockId }) {
      notesFor(workspaceId).delete(blockId);
      return snapshot(workspaceId);
    },
    async markReviewed({ workspaceId, blockId }) {
      const notes = notesFor(workspaceId);
      const existing = notes.get(blockId);
      if (existing === undefined) throw new Error("This block has no note to review.");
      notes.set(blockId, { ...existing, sourceFingerprint: "preview", stale: false });
      return snapshot(workspaceId);
    },
    async removeStale({ workspaceId }) {
      const notes = notesFor(workspaceId);
      for (const [blockId, note] of [...notes]) {
        if (note.stale) notes.delete(blockId);
      }
      return snapshot(workspaceId);
    },
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
