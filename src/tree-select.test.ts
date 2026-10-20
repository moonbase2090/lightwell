import assert from "node:assert/strict";
import test from "node:test";
import {
  TREE_SELECT_ACTION_KEY,
  parseTreeSelectAction,
  readTreeSelectAction,
  writeTreeSelectAction,
  type TreeSelectStorage,
} from "./tree-select.js";

class MemoryStorage implements TreeSelectStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("tree selection opens source by default and only stored show-details changes that", () => {
  assert.equal(parseTreeSelectAction(null), "open-source");
  assert.equal(parseTreeSelectAction(""), "open-source");
  assert.equal(parseTreeSelectAction("open-source"), "open-source");
  assert.equal(parseTreeSelectAction("yes"), "open-source");
  assert.equal(parseTreeSelectAction("show-details"), "show-details");
  const storage = new MemoryStorage();
  assert.equal(readTreeSelectAction(storage), "open-source");
  writeTreeSelectAction(storage, "show-details");
  assert.equal(storage.getItem(TREE_SELECT_ACTION_KEY), "show-details");
  assert.equal(readTreeSelectAction(storage), "show-details");
  writeTreeSelectAction(storage, "open-source");
  assert.equal(readTreeSelectAction(storage), "open-source");
  assert.equal(readTreeSelectAction(null), "open-source");
});

test("tree selection choice survives unreadable storage by keeping the default", () => {
  const broken: TreeSelectStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  };
  assert.equal(readTreeSelectAction(broken), "open-source");
  writeTreeSelectAction(broken, "show-details");
  assert.equal(readTreeSelectAction(broken), "open-source");
});
