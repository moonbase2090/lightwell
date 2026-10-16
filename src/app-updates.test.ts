import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UpdatePrompt from "./UpdatePrompt.js";
import {
  RELEASES_URL,
  UPDATE_CHECK_KEY,
  parseUpdateCheck,
  parseUpdateDelivery,
  readUpdateCheck,
  updateAction,
  writeUpdateCheck,
  type UpdateStorage,
} from "./app-updates.js";

class MemoryStorage implements UpdateStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("update checks default on and only an explicit off is restored", () => {
  assert.equal(parseUpdateCheck(null), true);
  assert.equal(parseUpdateCheck(""), true);
  assert.equal(parseUpdateCheck("on"), true);
  assert.equal(parseUpdateCheck("yes"), true);
  assert.equal(parseUpdateCheck("off"), false);
  const storage = new MemoryStorage();
  assert.equal(readUpdateCheck(storage), true);
  writeUpdateCheck(storage, false);
  assert.equal(storage.getItem(UPDATE_CHECK_KEY), "off");
  assert.equal(readUpdateCheck(storage), false);
  writeUpdateCheck(storage, true);
  assert.equal(readUpdateCheck(storage), true);
  assert.equal(readUpdateCheck(null), true);
  const throwing: UpdateStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  assert.equal(readUpdateCheck(throwing), true);
  writeUpdateCheck(throwing, false);
});

test("deb, rpm, and tarball installs link to the release instead of installing", () => {
  assert.equal(parseUpdateDelivery("manual"), "manual");
  assert.equal(parseUpdateDelivery("integrated"), "integrated");
  assert.equal(parseUpdateDelivery(null), "integrated");
  assert.equal(parseUpdateDelivery("other"), "integrated");
  assert.equal(updateAction("integrated"), "install");
  assert.equal(updateAction("manual"), "download");
  assert.equal(updateAction("unavailable"), "none");
  assert.equal(RELEASES_URL, "https://github.com/moonbase2090/lightwell/releases/latest");
});

test("the update prompt shows notes before install and a download link for manual packages", () => {
  const integrated = renderToStaticMarkup(createElement(UpdatePrompt, {
    version: "0.1.13",
    notes: "Fixes the map.",
    delivery: "integrated",
    installing: false,
    onInstall: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(integrated, /Version 0\.1\.13/);
  assert.match(integrated, /Fixes the map\./);
  assert.match(integrated, />Install update</);
  assert.equal(integrated.includes("Download update"), false);

  const emptyNotes = renderToStaticMarkup(createElement(UpdatePrompt, {
    version: "0.1.13",
    notes: "",
    delivery: "integrated",
    installing: true,
    onInstall: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(emptyNotes, /No release notes for this version\./);
  assert.match(emptyNotes, /Installing…/);
  assert.match(emptyNotes, /disabled/);

  const manual = renderToStaticMarkup(createElement(UpdatePrompt, {
    version: "0.1.13",
    notes: "Fixes the map.",
    delivery: "manual",
    installing: false,
    onInstall: () => undefined,
    onClose: () => undefined,
  }));
  assert.match(manual, /cannot replace itself/);
  assert.match(manual, new RegExp(`href="${RELEASES_URL}"`));
  assert.equal(manual.includes(">Install update<"), false);
});
