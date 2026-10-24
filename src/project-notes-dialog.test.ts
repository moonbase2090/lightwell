import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectNotesSnapshot, ProjectNotesSource } from "./map-source.js";
import type { ResolvedMap } from "./model.js";
import ProjectNotesDialog from "./ProjectNotesDialog.js";

const source: ProjectNotesSource = {
  add: () => Promise.reject(new Error("unused")),
  edit: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  markReviewed: () => Promise.reject(new Error("unused")),
  removeStale: () => Promise.reject(new Error("unused")),
};

function mapWith(blocks: readonly { readonly id: string; readonly label: string }[]): ResolvedMap {
  return {
    blockById: new Map(blocks.map((block) => [block.id, { id: block.id, label: block.label }])),
  } as unknown as ResolvedMap;
}

function renderNotes(snapshot: ProjectNotesSnapshot, currentBlockId: string | null, blocks: readonly { readonly id: string; readonly label: string }[] = []): string {
  return renderToStaticMarkup(createElement(ProjectNotesDialog, {
    workspaceId: "workspace-1",
    source,
    snapshot,
    map: mapWith(blocks),
    currentBlockId,
    onSnapshot: () => undefined,
    onClose: () => undefined,
  }));
}

test("project notes lists current notes before stale ones and names their state", () => {
  const html = renderNotes({
    kind: "ready",
    notes: [
      { blockId: "crate:zeta", text: "later\nline", sourceFingerprint: "b", author: "preview", updatedAt: "2026-10-25T03:00:00Z", stale: false },
      { blockId: "missing", text: "orphaned", sourceFingerprint: "c", author: "unknown", updatedAt: "", stale: true },
      { blockId: "crate:alpha", text: "first", sourceFingerprint: "a", author: "preview", updatedAt: "2026-10-25T03:00:00Z", stale: false },
      { blockId: "crate:moved", text: "shifted", sourceFingerprint: "d", author: "preview", updatedAt: "2026-10-24T12:00:00Z", stale: true },
    ],
  }, "crate:alpha", [
    { id: "crate:alpha", label: "alpha" },
    { id: "crate:zeta", label: "zeta" },
    { id: "crate:moved", label: "moved" },
  ]);

  const alpha = html.indexOf("alpha");
  const zeta = html.indexOf("zeta");
  const moved = html.indexOf("moved");
  const missing = html.indexOf(">missing<");
  assert.ok(alpha !== -1 && zeta !== -1 && moved !== -1 && missing !== -1);
  assert.ok(alpha < zeta && zeta < moved && moved < missing);
  assert.match(html, /4 saved/);
  assert.match(html, /class="project-note-row selected"/);
  assert.match(html, /later line/);
  assert.match(html, /class="project-note-badge">[\s\S]*Current/);
  assert.match(html, /class="project-note-badge stale">[\s\S]*Source changed/);
  assert.match(html, /class="project-note-badge stale">[\s\S]*Block removed/);
  assert.match(html, /NOTE FOR/);
  assert.match(html, /<strong>alpha<\/strong>/);
  assert.match(html, />Save changes</);
  assert.match(html, /class="notes-remove-button"/);
  assert.match(html, /class="notes-bulk-remove-button"[^>]*>[\s\S]*Delete stale \(2\)/);
  assert.equal(html.includes("NEW NOTE FOR"), false);
  assert.equal(html.includes("Mark reviewed"), false);
});

test("project notes offers Mark reviewed for a stale note whose block still exists", () => {
  const html = renderNotes({
    kind: "ready",
    notes: [{ blockId: "crate:moved", text: "still good", sourceFingerprint: "old", stale: true }],
  }, "crate:moved", [{ id: "crate:moved", label: "moved" }]);

  assert.match(html, /class="notes-review-button"[^>]*>[\s\S]*Mark reviewed/);
  assert.match(html, /Mark reviewed if the note still matches/);
  assert.match(html, /class="notes-bulk-remove-button"[^>]*>[\s\S]*Delete stale \(1\)/);
});

test("project notes hides stale actions when the source omits them", () => {
  const gated: ProjectNotesSource = {
    add: () => Promise.reject(new Error("unused")),
    edit: () => Promise.reject(new Error("unused")),
    remove: () => Promise.reject(new Error("unused")),
  };
  const html = renderToStaticMarkup(createElement(ProjectNotesDialog, {
    workspaceId: "workspace-1",
    source: gated,
    snapshot: {
      kind: "ready",
      notes: [{ blockId: "crate:moved", text: "still good", sourceFingerprint: "old", stale: true }],
    },
    map: mapWith([{ id: "crate:moved", label: "moved" }]),
    currentBlockId: "crate:moved",
    onSnapshot: () => undefined,
    onClose: () => undefined,
  }));
  assert.equal(html.includes("notes-review-button"), false);
  assert.equal(html.includes("notes-bulk-remove-button"), false);
  assert.match(html, /This note is kept until you remove it/);
});

test("project notes does not offer Mark reviewed for an orphaned stale note", () => {
  const html = renderNotes({
    kind: "ready",
    notes: [{ blockId: "missing", text: "orphaned", sourceFingerprint: "c", stale: true }],
  }, "missing");

  assert.equal(html.includes("notes-review-button"), false);
  assert.match(html, /This note is kept until you remove it/);
  assert.match(html, /class="notes-bulk-remove-button"/);
});

test("project notes opens a blank editor for the selected block", () => {
  const html = renderNotes({ kind: "ready", notes: [] }, "crate:core", [
    { id: "crate:core", label: "core" },
  ]);

  assert.match(html, /0 saved/);
  assert.match(html, /No notes yet\./);
  assert.match(html, /NEW NOTE FOR/);
  assert.match(html, /<strong>core<\/strong>/);
  assert.match(html, /class="notes-save-button"[^>]*disabled/);
  assert.match(html, />Save note</);
  assert.equal(html.includes("notes-remove-button"), false);
  assert.equal(html.includes("notes-new-button\" type=\"button\" disabled"), false);
});

test("project notes refuses a blank or whitespace-only saved note", () => {
  const html = renderNotes({
    kind: "ready",
    notes: [{ blockId: "crate:core", text: "   ", sourceFingerprint: "a", author: "preview", updatedAt: "2026-10-25T03:00:00Z", stale: false }],
  }, "crate:core", [{ id: "crate:core", label: "core" }]);

  assert.match(html, /class="notes-save-button"[^>]*disabled/);
  assert.match(html, />Save changes</);
});

test("project notes explains an unreadable workspace and disables editing", () => {
  const html = renderNotes({ kind: "error", message: "notes file is unreadable" }, null);

  assert.match(html, /Notes unavailable/);
  assert.match(html, /Notes could not be read from this workspace\./);
  assert.match(html, /role="alert">notes file is unreadable/);
  assert.match(html, /Choose a block from the map/);
  assert.match(html, /class="notes-new-button"[^>]*disabled/);
  assert.match(html, /aria-label="Project note text"[^>]*disabled/);
  assert.match(html, /class="notes-save-button"[^>]*disabled/);
});

test("project notes empty state offers Add note for the chosen block", () => {
  const html = renderNotes({ kind: "ready", notes: [] }, "crate:core", [{ id: "crate:core", label: "core" }]);
  assert.match(html, /No notes yet\./);
  assert.match(html, /class="notes-empty-add-button"[^>]*>.*Add note to core<\/button>/);
});

test("project notes empty state without a chosen block tells the user how to add one", () => {
  const html = renderNotes({ kind: "ready", notes: [] }, null);
  assert.match(html, /Select a block on the map, then choose Add note or right-click it\./);
  assert.doesNotMatch(html, /notes-empty-add-button/);
});

test("project notes starts a new note with the line reference passed from the source inspector", () => {
  const html = renderToStaticMarkup(createElement(ProjectNotesDialog, {
    workspaceId: "workspace-1",
    source,
    snapshot: { kind: "ready", notes: [] },
    map: mapWith([{ id: "crate:core", label: "core" }]),
    currentBlockId: "crate:core",
    initialText: "Line 12: ",
    onSnapshot: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(html, /<textarea[^>]*>Line 12: <\/textarea>/);
});
