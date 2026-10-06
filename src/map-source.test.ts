import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureMapSource } from "./map-sources/fixtures.js";
import { parseAnnotationOverlay, parseFactMap, resolveMap } from "./schema.js";

test("fixture map source loads the checked-in Prismattyc and Scorecard maps", async () => {
  const entries = await fixtureMapSource.listMaps();
  const loadedProjects = await Promise.all(entries.map(async (entry) => {
    const document = await fixtureMapSource.loadMap(entry.id);
    const map = resolveMap(
      parseFactMap(document.facts),
      parseAnnotationOverlay(document.annotations),
    );
    assert.equal(
      map.facts.project.name,
      entry.label,
      `Map source entry ${entry.id} labels ${entry.label}, but facts name ${map.facts.project.name}.`,
    );
    return map.facts.project.name;
  }));

  assert.deepEqual([...loadedProjects].sort(), ["Prismattyc", "Scorecard"]);
});

test("fixture map source rejects an unknown map id", async () => {
  await assert.rejects(fixtureMapSource.loadMap("missing"), /not available in the browser preview/);
});
