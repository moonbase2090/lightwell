import { readFileSync } from "node:fs";
import { parseFactMap } from "../src/schema.js";

const factsPath = process.argv[2];
if (factsPath === undefined) throw new Error("Usage: check-map <facts.json>");

const map = parseFactMap(JSON.parse(readFileSync(factsPath, "utf8")));
console.log(`Valid Lightwell schema v${map.schemaVersion} map: ${map.stats.blocks} blocks, ${map.stats.connections} connections.`);
