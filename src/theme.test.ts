import assert from "node:assert/strict";
import test from "node:test";
import { isThemePreference, readThemePreference, resolveTheme, saveThemePreference } from "./theme.js";

function withStorage(storage: Map<string, string>, run: () => void): void {
  const target = globalThis as { window?: Window };
  const previous = target.window;
  target.window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  } as Window;
  try {
    run();
  } finally {
    if (previous === undefined) delete target.window;
    else target.window = previous;
  }
}

test("theme preference accepts only the four saved choices", () => {
  assert.equal(isThemePreference("system"), true);
  assert.equal(isThemePreference("dark"), true);
  assert.equal(isThemePreference("light"), true);
  assert.equal(isThemePreference("blueprint"), true);
  assert.equal(isThemePreference("sepia"), false);
  assert.equal(isThemePreference(""), false);
  assert.equal(isThemePreference(null), false);
});

test("stored theme falls back to the system preference when the value is missing or invalid", () => {
  withStorage(new Map(), () => {
    assert.equal(readThemePreference(), "system");
  });
  withStorage(new Map([["lightwell.theme", "blueprint"]]), () => {
    assert.equal(readThemePreference(), "blueprint");
  });
  withStorage(new Map([["lightwell.theme", "sepia"]]), () => {
    assert.equal(readThemePreference(), "system");
  });
});

test("theme storage failures leave the session on the system preference", () => {
  const target = globalThis as { window?: Window };
  const previous = target.window;
  target.window = {
    localStorage: {
      getItem: () => { throw new Error("storage is disabled"); },
      setItem: () => { throw new Error("storage is disabled"); },
    },
  } as unknown as Window;
  try {
    assert.equal(readThemePreference(), "system");
    assert.doesNotThrow(() => saveThemePreference("dark"));
  } finally {
    if (previous === undefined) delete target.window;
    else target.window = previous;
  }
});

test("saving a theme writes the preference and resolution follows system only for that choice", () => {
  const storage = new Map<string, string>();
  withStorage(storage, () => {
    saveThemePreference("light");
    assert.equal(storage.get("lightwell.theme"), "light");
    assert.equal(readThemePreference(), "light");
  });

  assert.equal(resolveTheme("system", "dark"), "dark");
  assert.equal(resolveTheme("system", "light"), "light");
  assert.equal(resolveTheme("blueprint", "dark"), "blueprint");
  assert.equal(resolveTheme("light", "dark"), "light");
});
