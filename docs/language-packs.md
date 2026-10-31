# Language packs

Language packs teach Lightwell which files belong to a language and which Monaco language ID to use when displaying them. A pack is a JSON manifest with an explicit schema version. Lightwell validates the same format in its TypeScript viewer and Rust desktop backend.

Version 1 manifests are data, not executable plugins. They can use Monaco language IDs already available in Lightwell. Extractor and highlighter hook names must resolve to code installed by the Lightwell host; an external manifest cannot load arbitrary JavaScript or native code.

## Create a pack

Start with this routing-only manifest:

```json
{
  "schemaVersion": 1,
  "id": "demo",
  "packVersion": "1.0.0",
  "extensions": [".demo"],
  "basenames": ["DemoFile"],
  "basenamePrefixes": [],
  "monaco": {
    "id": "plaintext",
    "highlighter": null,
    "byExtension": {},
    "byBasename": {},
    "byBasenamePrefix": {}
  },
  "extractors": {
    "source": null,
    "workspace": null
  },
  "fixtures": null
}
```

The machine-readable schema is [language-pack.schema.json](language-pack.schema.json). Every field is required so a manifest has one unambiguous shape.

- `schemaVersion` is `1`. Lightwell rejects versions it does not understand.
- `id` starts with a lowercase letter and contains only lowercase letters, digits, and hyphens.
- `packVersion` is a version such as `1.2.3` or `1.2.3-beta.1`.
- `extensions` contains lowercase extensions with their leading dot.
- `basenames` contains exact filename matches, such as `DemoFile`.
- `basenamePrefixes` contains filename prefixes, such as `Dockerfile.`.
- `monaco.id` is the default Monaco language ID for the pack.
- `monaco.byExtension`, `byBasename`, and `byBasenamePrefix` override that default for a matching path rule. Basename override keys must appear in the corresponding top-level list.
- `monaco.highlighter`, `extractors.source`, and `extractors.workspace` name host-installed hooks. Use `null` for an external routing-only pack.
- `fixtures` is a repository-relative fixture root used by built-in pack tests, or `null`.

At least one extension, basename, or basename prefix is required. Unknown fields, duplicate rules, path separators in basenames, unknown hooks, and malformed versions are errors.

## Install a pack

The desktop Settings screen can install a bundled catalog pack or a manifest selected from disk. Selecting a directory installs its `language-pack.json`; version 1 packs do not copy or execute companion files. Installed manifests live in Lightwell's application configuration directory under `language-packs`; Settings shows and opens the exact directory for the current platform.

For a project-local pack, add either of these layouts to the repository:

```text
.lightwell/language-packs/demo.language-pack.json
.lightwell/language-packs/demo/language-pack.json
```

The Node loader also checks `LIGHTWELL_LANGUAGE_PACKS_DIR`. When that variable is absent, it uses `~/.lightwell/language-packs` for user packs. The desktop app passes its platform-specific application configuration directory instead.

Lightwell loads built-ins first, then user packs, then workspace packs. Packs do not override one another. A duplicate ID, extension, basename, or overlapping basename prefix produces a catalog error for the later pack while other valid packs remain active.

## Validate changes

Run the parity gate after changing a manifest, built-in pack, or loader:

```sh
npm run check:language-packs
```

The command regenerates the built-in catalog and fails if it changed, verifies that the bundled and workspace sample manifests match, and runs the TypeScript and Rust loader tests. Commit the generated catalog after an intentional built-in change:

```sh
npm run generate:language-packs
git add src/languages/manifests/builtin.language-packs.json
```

The complete sample lives at `crates/lightwell-core/fixtures/language-pack-sample`. TOML is the built-in example loaded from a version 1 JSON manifest.

## Schema compatibility

Treat `schemaVersion` and `packVersion` separately. `schemaVersion` describes the manifest format that Lightwell must understand. `packVersion` describes the pack release and is displayed in the catalog.

Additive or breaking format changes require a new schema version and a new parser branch. Do not silently reinterpret a version 1 field. Keep the TypeScript type and parser, Rust serde type and validator, JSON Schema, samples, and generated built-in catalog in the same change.
