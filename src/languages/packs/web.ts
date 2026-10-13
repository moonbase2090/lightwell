import type { LanguagePack } from "../language-pack.js";
import { registerWebHighlighters } from "../highlighters/web.js";

/** Web front-end sources (TS/JS/JSX/TSX/HTML/CSS) appended by workspace extraction. */
export const WEB_LANGUAGE_PACK: LanguagePack = {
  id: "web",
  extensions: [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".html",
    ".htm",
    ".css",
    ".scss",
  ],
  basenameFiles: ["package.json", "tsconfig.json", "jsconfig.json"],
  basenamePrefixes: ["vite.config.", "next.config."],
  monacoLanguageId: "typescript",
  monacoIdByExtension: {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".json": "json",
  },
  extractor: {
    kind: "web-module",
    moduleId: "extract/web-modules",
    coreSourceModule: "lightwell_core::typescript_source",
  },
  workspaceExtractor: null,
  registerHighlighter: registerWebHighlighters,
  fixtures: { root: "crates/lightwell-core/fixtures/web-sample" },
};

/** @deprecated Use `WEB_LANGUAGE_PACK`. */
export const TYPESCRIPT_LANGUAGE_PACK = WEB_LANGUAGE_PACK;
