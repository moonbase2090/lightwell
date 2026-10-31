import type { LanguagePack } from "../language-pack.js";
import { registerConfigInfraHighlighters } from "../highlighters/config-infra.js";

export const CONFIG_INFRA_LANGUAGE_PACK: LanguagePack = {
  id: "config-infra",
  packVersion: "1.0.0",
  extensions: [".yaml", ".yml", ".tf", ".tfvars", ".hcl"],
  basenameFiles: ["Dockerfile"],
  basenamePrefixes: ["Dockerfile."],
  monacoLanguageId: "yaml",
  monacoIdByExtension: { ".yaml": "yaml", ".yml": "yaml", ".tf": "terraform", ".tfvars": "terraform", ".hcl": "terraform" },
  monacoIdByBasename: { dockerfile: "dockerfile" },
  monacoIdByBasenamePrefix: { "dockerfile.": "dockerfile" },
  extractor: {
    kind: "config-infra-module",
    moduleId: "extract/config-infra",
    coreSourceModule: "lightwell_core::config_infra_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerConfigInfraHighlighters,
  fixtures: { root: "crates/lightwell-core/fixtures/config-infra-sample" },
};
