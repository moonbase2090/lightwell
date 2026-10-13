import type { FactMap } from "../model.js";
import type { WorkspaceExtractArgs } from "./language-pack.js";
import { languagePackById } from "./registry.js";

/** Run the active workspace extractor (built-in Rust pack today). */
export function extractWorkspaceMap(args: WorkspaceExtractArgs): FactMap {
  const rust = languagePackById("rust");
  const extract = rust?.workspaceExtractor;
  if (extract === null || extract === undefined) {
    throw new Error("No workspace language pack is configured for extraction.");
  }
  return extract(args);
}
