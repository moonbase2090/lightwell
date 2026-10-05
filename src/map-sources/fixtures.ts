import prismattycAnnotations from "../../maps/prismattyc.annotations.json";
import prismattycFacts from "../../maps/prismattyc.facts.json";
import scorecardAnnotations from "../../maps/scorecard.annotations.json";
import scorecardFacts from "../../maps/scorecard.facts.json";
import type { MapSource, MapSourceDocument } from "../map-source.js";

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

const entries = Object.entries(fixtures).map(([id, fixture]) => ({ id, label: fixture.label }));

export const fixtureMapSource: MapSource = {
  async listMaps() {
    return entries;
  },
  async loadMap(id) {
    const fixture = fixtures[id];
    if (fixture === undefined) {
      throw new Error(`Map \"${id}\" is not available in the browser preview.`);
    }
    return { facts: fixture.facts, annotations: fixture.annotations };
  },
};
