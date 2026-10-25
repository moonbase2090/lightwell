import type * as Monaco from "monaco-editor-core";

export function registerConfigInfraHighlighters(monaco: typeof Monaco): void {
  register(monaco, "yaml", {
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*[-?]\s+/, "operator"],
        [/^\s*[\w.'"/-]+(?=\s*:)/, "type.identifier"],
        [/[{}\[\],]/, "delimiter"],
        [/:|-/ , "operator"],
        [/(?:^|\s)#.*$/, "comment"],
        [/[|>]/, "string"],
        [/["'][^"']*["']/, "string"],
        [/\b(?:true|false|null|yes|no|on|off)\b/i, "keyword"],
        [/-?\d+(?:\.\d+)?\b/, "number"],
      ],
    },
  });
  register(monaco, "terraform", {
    keywords: ["resource", "data", "module", "variable", "output", "provider", "locals", "terraform", "depends_on", "for_each", "count", "true", "false", "null"],
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/[=<>!~?:&|+\-*/^%]+/, "operator"],
        [/#.*$|\/\/.*$/, "comment"],
        [/\d+(?:\.\d+)?/, "number"],
        [/"/, { token: "string", next: "@string" }],
      ],
      string: [[/[^\\"]+/, "string"], [/\\./, "string.escape"], [/"/, { token: "string", next: "@pop" }]],
    },
  });
  register(monaco, "dockerfile", {
    keywords: ["FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "AS"],
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*[A-Z]+\b/i, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/[=<>!~?:&|+\-*/^%]+/, "operator"],
        [/\$\{?[\w]+\}?/, "variable"],
        [/#.*$/, "comment"],
        [/\d+/, "number"],
        [/"/, { token: "string", next: "@string" }],
      ],
      string: [[/[^\\"]+/, "string"], [/\\./, "string.escape"], [/"/, { token: "string", next: "@pop" }]],
    },
  });
}

function register(monaco: typeof Monaco, id: string, grammar: Parameters<typeof monaco.languages.setMonarchTokensProvider>[1]): void {
  if (monaco.languages.getLanguages().some((language) => language.id === id)) return;
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, grammar);
}
