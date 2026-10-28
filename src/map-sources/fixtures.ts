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
  type StoredMemoryNote =
    | { readonly kind: "legacy"; readonly text: string; readonly sourceFingerprint: string; readonly stale: boolean }
    | { readonly kind: "revisioned"; readonly note: MemoryNote; readonly stale: boolean };
  const compareRevisions = typeof import.meta.env !== "undefined" && import.meta.env.VITE_ENABLE_NOTES_CAS === "true";
  const notesByWorkspace = new Map<string, Map<string, StoredMemoryNote>>();
  const snapshot = (workspaceId: string): ProjectNotesSnapshot => ({
    kind: "ready",
    notes: [...(notesByWorkspace.get(workspaceId) ?? new Map<string, StoredMemoryNote>())].map(
      ([blockId, stored]) =>
        stored.kind === "legacy"
          ? {
              blockId,
              text: stored.text,
              sourceFingerprint: stored.sourceFingerprint,
              author: PREVIEW_NOTE_AUTHOR,
              updatedAt: PREVIEW_NOTE_UPDATED_AT,
              stale: stored.stale,
            }
          : {
              blockId,
              text: stored.note.text,
              sourceFingerprint: stored.note.sourceFingerprint,
              author: PREVIEW_NOTE_AUTHOR,
              updatedAt: PREVIEW_NOTE_UPDATED_AT,
              stale: stored.stale,
              revision: stored.note.revision,
            },
    ),
  });
  const notesFor = (workspaceId: string) => {
    const existing = notesByWorkspace.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StoredMemoryNote>();
    notesByWorkspace.set(workspaceId, created);
    return created;
  };
  const writeCompared = async (mode: "add" | "edit", input: ProjectNoteInput) => {
    const notes = notesFor(input.workspaceId);
    const current = notes.get(input.blockId);
    const existing = current === undefined
      ? undefined
      : current.kind === "revisioned"
        ? current.note
        : {
            text: current.text,
            sourceFingerprint: current.sourceFingerprint,
            revision: await noteRevision(current.text, current.sourceFingerprint),
          };
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
    notes.set(input.blockId, { kind: "revisioned", note: written.note, stale: false });
    return snapshot(input.workspaceId);
  };
  return {
    async add(input) {
      if (compareRevisions) return writeCompared("add", input);
      const notes = notesFor(input.workspaceId);
      if (notes.has(input.blockId)) throw new Error("This block already has a note.");
      notes.set(input.blockId, {
        kind: "legacy",
        text: input.text,
        sourceFingerprint: "preview",
        stale: false,
      });
      return snapshot(input.workspaceId);
    },
    async edit(input) {
      if (compareRevisions) return writeCompared("edit", input);
      const notes = notesFor(input.workspaceId);
      const existing = notes.get(input.blockId);
      if (existing === undefined) throw new Error("This block has no note to edit.");
      if (existing.kind === "legacy") {
        notes.set(input.blockId, { ...existing, text: input.text });
      } else {
        const sourceFingerprint = existing.note.sourceFingerprint;
        const note = {
          ...existing.note,
          text: input.text,
          revision: await noteRevision(input.text, sourceFingerprint),
        };
        notes.set(input.blockId, { kind: "revisioned", note, stale: existing.stale });
      }
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
        if (existing.kind === "legacy") {
          notes.set(blockId, { ...existing, sourceFingerprint: "preview", stale: false });
        } else {
          const text = existing.note.text;
          notes.set(blockId, {
            kind: "revisioned",
            note: {
              ...existing.note,
              sourceFingerprint: "preview",
              revision: await noteRevision(text, "preview"),
            },
            stale: false,
          });
        }
        return snapshot(workspaceId);
      },
      async removeStale({ workspaceId }: { workspaceId: string }) {
        const notes = notesFor(workspaceId);
        for (const [blockId, note] of [...notes]) {
          if (note.stale) notes.delete(blockId);
        }
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
