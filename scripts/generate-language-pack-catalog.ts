import { writeFileSync } from "node:fs";
import path from "node:path";
import { BUILTIN_LANGUAGE_PACKS } from "../src/languages/builtin-packs.js";
import { manifestForLanguagePack } from "../src/languages/loader.js";

const outputPath = path.join(
  process.cwd(),
  "src",
  "languages",
  "manifests",
  "builtin.language-packs.json",
);
const manifests = BUILTIN_LANGUAGE_PACKS.map(manifestForLanguagePack);
writeFileSync(outputPath, `${JSON.stringify(manifests, null, 2)}\n`, "utf8");
console.log(`Wrote ${manifests.length} built-in language pack manifests.`);
