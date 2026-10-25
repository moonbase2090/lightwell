import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectNoteView } from "./map-source.js";
import {
  applyMemoryNoteWrite,
  noteRevision,
  planNotesReload,
  readNoteRevisionConflict,
  type MemoryNote,
} from "./notes-reload.js";

function note(blockId: string, text: string, revision: string): ProjectNoteView {
  return { blockId, text, sourceFingerprint: "fp", stale: false, revision };
}

test("note revision matches the stored SHA-256 of text, NUL, and fingerprint", async () => {
  assert.equal(
    await noteRevision("hello", "fp-1"),
    "dda9741c5b84db79fb1fa2616b07ba1b5dd9f18a63f7de9ef2cbe9e0a1f496af",
  );
  assert.notEqual(await noteRevision("hello", "fp-1"), await noteRevision("hello", "fp-2"));
  assert.notEqual(await noteRevision("hello", "fp-1"), await noteRevision("hellp", "fp-1"));
  assert.notEqual(await noteRevision("ab", "c"), await noteRevision("a", "bc"));
});

test("a clean editor adopts a changed note and a removed selection becomes a new note", () => {
  const adopted = planNotesReload(
    { kind: "saved", blockId: "crate:core", text: "loaded", loadedText: "loaded" },
    [note("crate:core", "from-disk", "rev-2")],
    new Map([["crate:core", "rev-1"]]),
  );
  assert.equal(adopted.kind, "adopt");
  if (adopted.kind !== "adopt") return;
  assert.equal(adopted.text, "from-disk");
  assert.equal(adopted.loadedText, "from-disk");
  assert.equal(adopted.loadedRevision, "rev-2");
  assert.equal(adopted.notice, null);

  const removed = planNotesReload(
    { kind: "saved", blockId: "crate:core", text: "loaded", loadedText: "loaded" },
    [note("crate:other", "kept", "rev-9")],
    new Map([["crate:core", "rev-1"]]),
  );
  assert.equal(removed.kind, "adopt");
  if (removed.kind !== "adopt") return;
  assert.equal(removed.editorKind, "new");
  assert.equal(removed.text, "");
  assert.equal(removed.notice, "This note was removed on disk.");
});

test("a dirty editor keeps its buffer when notes change and ignores its own save echo", () => {
  const pinned = planNotesReload(
    { kind: "saved", blockId: "crate:core", text: "draft", loadedText: "loaded" },
    [note("crate:core", "from-disk", "rev-2")],
    new Map([["crate:core", "rev-1"]]),
  );
  assert.equal(pinned.kind, "pin");
  assert.equal("text" in pinned, false);

  const newDraft = planNotesReload(
    { kind: "new", blockId: "crate:core", text: "unsaved", loadedText: "" },
    [note("crate:core", "from-disk", "rev-2")],
    new Map(),
  );
  assert.equal(newDraft.kind, "pin");

  const echo = planNotesReload(
    { kind: "saved", blockId: "crate:core", text: "draft", loadedText: "loaded" },
    [note("crate:core", "from-disk", "rev-2")],
    new Map([["crate:core", "rev-2"]]),
  );
  assert.equal(echo.kind, "ignore");
});

test("a clean empty new note adopts a note that appeared for that block", () => {
  const adopted = planNotesReload(
    { kind: "new", blockId: "crate:core", text: "", loadedText: "" },
    [note("crate:core", "from-disk", "rev-4")],
    new Map(),
  );
  assert.equal(adopted.kind, "adopt");
  if (adopted.kind !== "adopt") return;
  assert.equal(adopted.editorKind, "saved");
  assert.equal(adopted.text, "from-disk");
});

test("revision conflicts keep the disk note and reject a stale or missing revision", async () => {
  const stored: MemoryNote = {
    text: "on-disk",
    sourceFingerprint: "fp",
    revision: await noteRevision("on-disk", "fp"),
  };
  const absent = await applyMemoryNoteWrite("crate:core", stored, "draft", "fp", "absent", null);
  assert.equal(absent.ok, false);
  if (absent.ok) return;
  assert.equal(absent.conflict.current.kind, "present");
  if (absent.conflict.current.kind !== "present") return;
  assert.equal(absent.conflict.current.text, "on-disk");
  assert.equal(absent.conflict.current.revision, stored.revision);

  const stale = await applyMemoryNoteWrite("crate:core", stored, "draft", "fp", "matchesRevision", "stale-revision");
  assert.equal(stale.ok, false);
  if (!stale.ok && stale.conflict.current.kind === "present") {
    assert.equal(stale.conflict.current.text, "on-disk");
  } else {
    assert.fail("a stale revision should conflict with the note still on disk");
  }

  const missing = await applyMemoryNoteWrite("crate:core", undefined, "draft", "fp", "matchesRevision", stored.revision);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.conflict.current.kind, "deleted");

  const wrote = await applyMemoryNoteWrite("crate:core", stored, "draft", "fp", "matchesRevision", stored.revision);
  assert.equal(wrote.ok, true);
  if (!wrote.ok) return;
  assert.equal(wrote.note.text, "draft");
  assert.notEqual(wrote.note.revision, stored.revision);

  const created = await applyMemoryNoteWrite("crate:other", undefined, "fresh", "fp", "absent", null);
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.note.text, "fresh");
});

test("revision conflict payloads round-trip and malformed payloads do not", () => {
  const parsed = readNoteRevisionConflict({
    kind: "revisionConflict",
    blockId: "crate:core",
    current: { kind: "present", text: "disk", sourceFingerprint: "fp", revision: "abc" },
  });
  assert.equal(parsed?.current.kind === "present" ? parsed.current.text : null, "disk");
  assert.equal(readNoteRevisionConflict({ kind: "revisionConflict", blockId: "crate:core", current: { kind: "deleted" } })?.current.kind, "deleted");
  assert.equal(readNoteRevisionConflict({ kind: "revisionConflict", blockId: "", current: { kind: "deleted" } }), null);
  assert.equal(readNoteRevisionConflict("Could not save"), null);
  assert.equal(readNoteRevisionConflict({ kind: "message", message: "nope" }), null);
});
