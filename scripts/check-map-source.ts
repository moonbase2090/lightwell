import { fixtureMapSource } from "../src/map-sources/fixtures.js";
import { parseAnnotationOverlay, parseFactMap, resolveMap } from "../src/schema.js";

const entries = await fixtureMapSource.listMaps();
const expectedProjects = new Set(["Prismattyc", "Scorecard"]);
const loadedProjects = await Promise.all(entries.map(async (entry) => {
  const document = await fixtureMapSource.loadMap(entry.id);
  const map = resolveMap(
    parseFactMap(document.facts),
    parseAnnotationOverlay(document.annotations),
  );
  if (map.facts.project.name !== entry.label) {
    throw new Error(`Map source entry ${entry.id} labels ${entry.label}, but facts name ${map.facts.project.name}.`);
  }
  console.log(`Loaded ${entry.label}: ${map.facts.stats.blocks} blocks and ${map.annotations.features.length} features.`);
  return map.facts.project.name;
}));

for (const expectedProject of expectedProjects) {
  if (!loadedProjects.includes(expectedProject)) {
    throw new Error(`The browser fixture map source did not load ${expectedProject}.`);
  }
}
