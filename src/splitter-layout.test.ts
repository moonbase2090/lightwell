import assert from "node:assert/strict";
import test from "node:test";
import { clampPaneSize, defaultPaneSize, paneSizeStorageKey, readPaneSize, writePaneSize } from "./splitter-layout.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("keeps the default trailing panel size constant as the window changes", () => {
  assert.equal(defaultPaneSize(1272, 318), 954);
  assert.equal(defaultPaneSize(1432, 318), 1114);
  assert.equal(defaultPaneSize(639, 197), 442);
});

test("clamps a pane between both pane minimums", () => {
  assert.equal(clampPaneSize(12, 700, 240, 220), 240);
  assert.equal(clampPaneSize(680, 700, 240, 220), 480);
  assert.equal(clampPaneSize(360, 700, 240, 220), 360);
});

test("scales both minimums when the available space cannot satisfy them", () => {
  assert.equal(clampPaneSize(250, 300, 240, 220), 150);
});

test("keeps invalid requested sizes inside the legal pane bounds", () => {
  assert.equal(clampPaneSize(Number.NaN, 700, 240, 220), 240);
  assert.equal(clampPaneSize(Number.POSITIVE_INFINITY, 700, 240, 220), 240);
});

test("stores pane sizes independently for each project and splitter", () => {
  const storage = new MemoryStorage();
  assert.equal(writePaneSize(storage, "/work/alpha", "map-source", 432), true);
  assert.equal(writePaneSize(storage, "/work/alpha", "map-features", 278), true);
  assert.equal(writePaneSize(storage, "/work/beta", "map-source", 510), true);

  assert.equal(readPaneSize(storage, "/work/alpha", "map-source"), 432);
  assert.equal(readPaneSize(storage, "/work/alpha", "map-features"), 278);
  assert.equal(readPaneSize(storage, "/work/beta", "map-source"), 510);
  assert.equal(readPaneSize(storage, "/work/beta", "map-features"), null);
});

test("ignores corrupt, non-positive, and unavailable saved values", () => {
  const storage = new MemoryStorage();
  assert.equal(readPaneSize(storage, "/work/alpha", "map-source"), null);
  assert.equal(writePaneSize(storage, "/work/alpha", "map-source", Number.NaN), false);
  assert.equal(writePaneSize(storage, "/work/alpha", "map-source", 0), false);
  assert.equal(readPaneSize(storage, "/work/alpha", "map-source"), null);

  assert.equal(writePaneSize(storage, "/work/alpha", "map-source", 320), true);
  storage.values.set(paneSizeStorageKey("/work/alpha", "map-source"), "not-a-size");
  assert.equal(readPaneSize(storage, "/work/alpha", "map-source"), null);
});

test("treats inaccessible storage as unavailable", () => {
  const unavailable = {
    getItem: () => { throw new Error("storage is disabled"); },
    setItem: () => { throw new Error("storage is disabled"); },
  };
  assert.equal(readPaneSize(unavailable, "/work/alpha", "map-source"), null);
  assert.equal(writePaneSize(unavailable, "/work/alpha", "map-source", 320), false);
});
