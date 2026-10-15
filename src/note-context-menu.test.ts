import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NoteContextMenu, { isAddNoteShortcut, isContextMenuKey, noteMenuItems } from "./NoteContextMenu.js";
import { createMemoryNotesSource } from "./map-sources/fixtures.js";

const labels = (items: ReturnType<typeof noteMenuItems>) => items.map((item) => item.label);

test("block menu offers Add note when the block has no note", () => {
  assert.deepEqual(
    labels(noteMenuItems({ notesAvailable: true, hasNote: false, canOpen: true, sourcePath: "src/lib.rs" })),
    ["Add note", "Open source", "Copy path"],
  );
});

test("block menu offers Edit and Delete instead of Add when a note exists", () => {
  assert.deepEqual(
    labels(noteMenuItems({ notesAvailable: true, hasNote: true, canOpen: false, sourcePath: "src/lib.rs" })),
    ["Edit note", "Delete note", "Copy path"],
  );
});

test("block menu hides note actions when notes cannot be saved and Copy path without a path", () => {
  assert.deepEqual(
    labels(noteMenuItems({ notesAvailable: false, hasNote: true, canOpen: true, sourcePath: null })),
    ["Open source"],
  );
});

test("Shift+F10 and the ContextMenu key open the menu; plain F10 does not", () => {
  assert.equal(isContextMenuKey({ key: "F10", shiftKey: true }), true);
  assert.equal(isContextMenuKey({ key: "ContextMenu", shiftKey: false }), true);
  assert.equal(isContextMenuKey({ key: "F10", shiftKey: false }), false);
});

test("N adds a note unless typing in a field or combined with a modifier", () => {
  const press = { key: "n", metaKey: false, ctrlKey: false, altKey: false, targetTag: "DIV", targetEditable: false };
  assert.equal(isAddNoteShortcut(press), true);
  assert.equal(isAddNoteShortcut({ ...press, key: "N" }), true);
  assert.equal(isAddNoteShortcut({ ...press, targetTag: "INPUT" }), false);
  assert.equal(isAddNoteShortcut({ ...press, targetTag: "TEXTAREA" }), false);
  assert.equal(isAddNoteShortcut({ ...press, targetEditable: true }), false);
  assert.equal(isAddNoteShortcut({ ...press, metaKey: true }), false);
  assert.equal(isAddNoteShortcut({ ...press, key: "m" }), false);
});

test("context menu renders an accessible menu with a menuitem per action and the shortcut hint", () => {
  const html = renderToStaticMarkup(createElement(NoteContextMenu, {
    x: 10,
    y: 20,
    title: "parser",
    items: noteMenuItems({ notesAvailable: true, hasNote: true, canOpen: true, sourcePath: "src/parser.rs" }),
    onChoose: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(html, /role="menu"[^>]*aria-label="Actions for parser"/);
  assert.equal(html.match(/role="menuitem"/g)?.length, 4);
  assert.match(html, /Edit note<\/span><kbd aria-hidden="true">N<\/kbd>/);
  assert.match(html, /class="note-context-menu-item danger"[^>]*><svg[^>]*>.*?<\/svg><span>Delete note/);
});

test("preview notes source adds, edits, and removes notes per workspace", async () => {
  const notes = createMemoryNotesSource();
  const added = await notes.add({ workspaceId: "a", blockId: "crate:core", text: "first" });
  assert.deepEqual(added.kind === "ready" ? added.notes.map((note) => [note.blockId, note.text]) : [], [["crate:core", "first"]]);
  await assert.rejects(notes.add({ workspaceId: "a", blockId: "crate:core", text: "again" }), /already has a note/);
  const edited = await notes.edit({ workspaceId: "a", blockId: "crate:core", text: "second" });
  assert.equal(edited.kind === "ready" ? edited.notes[0]?.text : undefined, "second");
  const other = await notes.remove({ workspaceId: "b", blockId: "crate:core" });
  assert.deepEqual(other.kind === "ready" ? other.notes : null, []);
  const removed = await notes.remove({ workspaceId: "a", blockId: "crate:core" });
  assert.deepEqual(removed.kind === "ready" ? removed.notes : null, []);
});

test("the word wrap toggle appears only for source lines and names the next state", () => {
  const base = { notesAvailable: true, hasNote: false, canOpen: false, sourcePath: "src/lib.rs" } as const;
  assert.equal(labels(noteMenuItems(base)).includes("Turn word wrap on"), false);
  assert.equal(labels(noteMenuItems(base)).includes("Turn word wrap off"), false);
  assert.equal(labels(noteMenuItems({ ...base, wordWrap: false })).at(-1), "Turn word wrap on");
  assert.equal(labels(noteMenuItems({ ...base, wordWrap: true })).at(-1), "Turn word wrap off");
  assert.equal(noteMenuItems({ ...base, wordWrap: true }).at(-1)?.action, "toggle-word-wrap");
});
