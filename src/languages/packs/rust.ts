import { extractCargoMap } from "../../extract/cargo.js";
import type { LanguagePack } from "../language-pack.js";
import { registerRustHighlighter } from "../highlighters/rust.js";
import { registerTomlHighlighter } from "../highlighters/toml.js";

function registerRustWorkspaceHighlighters(monaco: Parameters<typeof registerRustHighlighter>[0]): void {
  registerRustHighlighter(monaco);
  registerTomlHighlighter(monaco);
}

/** Built-in Rust workspace pack: `extract_cargo_map` / `rust_source` parity and Cargo manifest TOML highlighting. */
export const RUST_LANGUAGE_PACK: LanguagePack = {
  id: "rust",
  extensions: [".rs"],
  monacoLanguageId: "rust",
  extractor: {
    kind: "rust-workspace",
    cargoMapModule: "extract/cargo",
    moduleTreeModule: "extract/rust-modules",
    coreSourceModule: "lightwell_core::rust_source",
  },
  workspaceExtractor: extractCargoMap,
  registerHighlighter: registerRustWorkspaceHighlighters,
  fixtures: { root: "crates/lightwell-core/fixtures" },
};
