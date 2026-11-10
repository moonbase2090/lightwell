# Language pack authoring

A language pack tells Lightwell which paths belong to a language, which Monaco language id to use for those paths, and which host-installed extractor and highlighter to call. Version 1 packs are JSON data. An external manifest cannot load JavaScript or native code.

There are two ways to add a language:

- A **built-in pack** is a `LanguagePack` object under `src/languages/packs/`. It ships in the default registry, so extraction and highlighting run on every map with no flag. Go (`src/languages/packs/go.ts`) is the smallest pack that extracts facts.
- An **external pack** is only a version 1 manifest. It can route files and name hooks the host already installed. The checked-in example is the `demo` pack.

The TypeScript parser is `parseLanguagePackManifest` in `src/languages/manifest.ts`. The Rust parser is `validate_language_pack_manifest` in `crates/lightwell-core/src/language_pack.rs`. The published shape is [`language-pack.schema.json`](language-pack.schema.json). Where those three disagree, this guide says so. A manifest that Lightwell loads has to pass the parser for the host that loads it.

## Manifest format

Every field below is required. Unknown fields are rejected. `null` is a value, so a nullable field must be present.

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

That object is the bundled sample at `resources/language-packs/demo/language-pack.json` and the workspace sample at `crates/lightwell-core/fixtures/language-pack-sample/.lightwell/language-packs/demo.language-pack.json`.

| Field | Shape |
| --- | --- |
| `schemaVersion` | The number `1`. |
| `id` | A string that starts with a lowercase letter and then contains only lowercase letters, digits, and hyphens. Built-in ids are `rust`, `toml`, `web`, `python`, `go`, `dotnet`, `php`, `ruby`, `jvm`, `swift`, `cpp`, and `config-infra`. |
| `packVersion` | A version such as `1.2.3` or `1.2.3-beta.1`. The numeric part is three dot-separated integers. An optional suffix starts with `-` and contains ASCII letters, digits, `.`, and `-`. |
| `extensions` | Lowercase extensions with a leading dot, such as `.go` or `.pyi`. The first character after the dot is a letter or digit. Later characters may also be `.`, `+`, or `-`. |
| `basenames` | Exact file names, such as `Dockerfile` or `pyproject.toml`. No `/` or `\`. |
| `basenamePrefixes` | File-name prefixes, such as `Dockerfile.` or `vite.config.`. No path separators. |
| `monaco.id` | Default Monaco language id for paths this pack owns. Any non-empty string. The parser does not check that Monaco already knows the id. |
| `monaco.highlighter` | A host hook name, or `null`. |
| `monaco.byExtension` | Map from an extension to a Monaco id. Keys use the extension pattern. A key does not have to appear in `extensions`. The web pack maps `.json` here and claims `package.json` through `basenames`. |
| `monaco.byBasename` | Map from a basename to a Monaco id. Each key must be one of this pack's `basenames`, compared case-insensitively. |
| `monaco.byBasenamePrefix` | Same rule for `basenamePrefixes`. |
| `extractors.source` | A host source-extractor hook name, or `null`. |
| `extractors.workspace` | A host workspace-extractor hook name, or `null`. Only the Rust pack sets this. |
| `fixtures` | A repository-relative fixture directory, or `null`. The loader stores the string. It does not open that directory. |

At least one of `extensions`, `basenames`, or `basenamePrefixes` must be non-empty.

Built-in manifests are generated, not hand-written, except TOML. `npm run generate:language-packs` writes `src/languages/manifests/builtin.language-packs.json` from `BUILTIN_LANGUAGE_PACKS` through `manifestForLanguagePack`:

- `monaco.highlighter` is the pack id when `registerHighlighter` is set, and `null` otherwise. TOML is `null` because `src/languages/packs/rust.ts` registers both the Rust and TOML tokenizers.
- `extractors.source` is `extractor.kind` (`go-module`, `python-module`, `rust-workspace`, and the other kinds in `LanguagePackExtractor`).
- `extractors.workspace` is the pack id when `workspaceExtractor` is set. That is `rust` today, and `null` for every other pack.
- `fixtures` is `fixtures.root`.

The generated Go manifest is the usual extracting shape: id `go`, extension `.go`, Monaco id `go`, highlighter `go`, source hook `go-module`, workspace hook `null`, fixtures `crates/lightwell-core/fixtures/go-sample`. Config-infra is the basename example: extensions `.yaml`, `.yml`, `.tf`, `.tfvars`, and `.hcl`; basename `Dockerfile`; prefix `Dockerfile.`; Monaco id `yaml`, with `.tf` / `.tfvars` / `.hcl` mapped to `terraform` and the Dockerfile rules mapped to `dockerfile`.

### Path routing

`languagePackForPath` in `src/languages/registry.ts` picks a pack from the path's file name. The file name is the last segment after `/` or `\`.

A basename or basename-prefix match wins over an extension match. Prefixes and basenames are compared case-insensitively. Among extensions, the longest matching suffix wins, which is why `.tsx` is not claimed by `.ts`. A path with no pack has no source language. Its Monaco id falls back to `rust`.

Inside a pack, Monaco id lookup is: an exact basename override, then the first basename-prefix override whose prefix matches, then the extension override, then `monaco.id`. `package.json`, `tsconfig.json`, and `jsconfig.json` use the `.json` override. `vite.config.*` and `next.config.*` use the extension after the last dot.

## Validation rules

Both parsers reject a bad manifest. They do not silently rewrite a field.

Shared rules:

- `schemaVersion` must be `1`. The error is `schemaVersion must be 1; received …`.
- `id` must match the pattern above. The Rust check is limited to ASCII.
- `packVersion` must match the version pattern above. The error is `packVersion must be a semantic version such as 1.2.3.`
- Extensions must be unique. The comparison is case-sensitive, and the pattern already requires lowercase.
- Basenames and basename prefixes must be unique, non-empty, and free of `/` and `\`. Uniqueness and later conflict checks use Unicode case folding, so `ÄFile` and `äfile` are the same name.
- Empty `extensions`, `basenames`, and `basenamePrefixes` together are rejected: `at least one extension, basename, or basename prefix is required.`
- `monaco.id`, hook strings, fixture strings, and Monaco map values must be non-empty. A string of only spaces fails.
- `monaco.byBasename` and `monaco.byBasenamePrefix` keys must name a rule declared on that same pack. The TypeScript error says the key `does not match a declared path rule.` The Rust error says the key `is not declared by this pack.`
- Nullable fields cannot be omitted. In TypeScript a missing `fixtures`, `monaco.highlighter`, `extractors.source`, or `extractors.workspace` fails as a non-empty string. In Rust, serde reports a missing field before validation. `deny_unknown_fields` rejects unknown keys on the Rust types. TypeScript reports the first unknown key as `contains unknown field …`.

Differences an author can hit:

- The TypeScript extension pattern and the JSON schema require a letter or digit immediately after the dot. The Rust `valid_extension` check also allows `.`, `+`, or `-` in that position. Write extensions that pass the stricter pattern.
- The JSON schema does not check hook names, and it does not check that basename override keys were declared. Both parsers do.
- Hook names are checked at different times. Rust checks them inside `validate_manifest` against the tables below. An unknown hook produces a message ending in `is not installed.` and the catalog records `unknown-hook`. TypeScript `parseLanguagePackManifest` only checks that a hook is `null` or a non-empty string. `languagePackFromManifest` resolves the name against the hook registry it was given. The Node loader passes an empty registry, so any non-null hook fails there with `is not installed.` The desktop activator passes the built-in hooks, so an external manifest can name a hook from the tables below and no others.

Installed hook names:

| Kind | Names |
| --- | --- |
| Highlighter (`monaco.highlighter`) | `config-infra`, `cpp`, `dotnet`, `go`, `jvm`, `php`, `python`, `ruby`, `rust`, `swift`, `web` |
| Source extractor (`extractors.source`) | `config-infra-module`, `cpp-module`, `dotnet-module`, `go-module`, `jvm-module`, `php-module`, `python-module`, `ruby-module`, `rust-workspace`, `swift-module`, `web-module` |
| Workspace extractor (`extractors.workspace`) | `rust` |

Naming a hook does not add a language. The name has to already be implemented in the host. A new extractor or tokenizer is a built-in pack, described below.

### Conflicts

Packs do not override each other. `validateLanguagePackConflicts` and the Rust `validate_conflicts` reject:

- the same `id`
- the same extension, compared in lowercase (`toLowerCase()` in TypeScript, `to_ascii_lowercase()` in Rust)
- the same basename, compared by Unicode lowercase
- a basename prefix that starts with another pack's prefix, in either direction
- a basename that starts with another pack's prefix

A pack may own both a basename and a prefix that overlap. Config-infra owns `Dockerfile` and `Dockerfile.`. The same-pack case is allowed. Two packs are not.

The message looks like `Language pack extension conflict for ".rs" between rust and rust-copy.`

### Where manifests are loaded

Built-ins load first, in the order of `BUILTIN_LANGUAGE_PACKS`. Then user manifests, then workspace manifests. Directory entries are sorted by file name. A conflict or invalid file becomes an error entry for that manifest. Packs loaded earlier stay active.

Discovery accepts two layouts, and ignores a directory that does not exist:

```text
.lightwell/language-packs/demo.language-pack.json
.lightwell/language-packs/demo/language-pack.json
```

The same two layouts apply to the user directory. A file must end in `.language-pack.json`. A subdirectory counts only when it contains `language-pack.json`.

The Node loader's user directory is `LIGHTWELL_LANGUAGE_PACKS_DIR`, or `~/.lightwell/language-packs` when that variable is unset. The Rust default is the same, using `HOME` or `USERPROFILE`. The desktop app does not use that default. It passes its application config directory plus `language-packs`.

Catalog error codes are `read`, `parse`, `validation`, `conflict`, and `unknown-hook`.

Installing from the desktop Settings screen copies one manifest and does not copy companion files. A directory selection uses `language-pack.json` inside it. The install destination is `<app config>/language-packs/<id>/language-pack.json`. A built-in id cannot be replaced. An id already loaded from the workspace cannot be installed. Updating an installed user pack requires replace. The Settings screen and the viewer path that activates external packs are included only when the build sets `VITE_ENABLE_LANGUAGE_PACKS=true`. Built-in packs do not use that variable. The Playwright web server in `playwright.config.ts` sets it. `e2e/language-packs.spec.ts` then installs the bundled `demo` pack through Settings.

The Settings catalog is a separate file, `language-packs/catalog.json`. It is not a language-pack manifest. It has `schemaVersion` 1, an integer `revision`, and `packs` entries with `id`, `packVersion`, `description`, and `extensions`. The catalog version pattern is three numeric components with no leading zeros and no suffix, such as `1.0.0`. The manifest version pattern is wider. The bundled `demo` resources are mapped by `crates/lightwell-app/tauri.conf.json` from `resources/language-packs/` to `language-packs/`.

## Validation command

After a manifest, built-in pack, sample, or loader change, run:

```sh
npm run check:language-packs
```

`scripts/check-language-pack-parity.mjs` does five things:

1. `npm run generate:language-packs`
2. `git diff --exit-code -- src/languages/manifests/builtin.language-packs.json`
3. Deep-equals the bundled `demo` manifest and the workspace sample manifest
4. `npm run test:language-packs`, which is `src/language-pack-loader.test.ts`
5. `cargo test -p lightwell-core --lib language_pack::tests --locked` and `cargo test -p lightwell-app --bin lightwell language_packs --locked`

When the built-in catalog change is intentional, regenerate it and commit the JSON:

```sh
npm run generate:language-packs
git add src/languages/manifests/builtin.language-packs.json
```

CI runs `npm test`, `cargo test -p lightwell-core --lib --locked`, and `cargo test -p lightwell-app --bin lightwell --locked`. Those include the loader tests, the registry tests, each language's module tests, and the Rust pack tests. They do not regenerate the catalog. `npm run check:language-packs` is the command that fails when the generated catalog drifts.

## Fixture layout

### Routing sample

`crates/lightwell-core/fixtures/language-pack-sample/` is a workspace root:

```text
crates/lightwell-core/fixtures/language-pack-sample/
  .lightwell/language-packs/demo.language-pack.json
  src/example.demo
```

`src/language-pack-loader.test.ts` loads that root with no user directory and expects `src/example.demo` and the path `nested/DemoFile` to resolve to pack `demo`, with Monaco id `plaintext`. The Rust test `sample_workspace_pack_loads_end_to_end` loads the same root and expects one manifest, id `demo`, extension `.demo`. `nested/DemoFile` is a routing input in the TypeScript test. It is not a file in the tree.

The bundled copy must stay deep-equal to that manifest. The parity command checks the two files. The Settings entry for this pack is the `demo` object in `language-packs/catalog.json`.

### Extractor fixtures

Each extracting pack names its fixture directory in `fixtures.root`. Tests open that directory directly. The registry test in `src/language-registry.test.ts` asserts these roots:

| Pack | `fixtures.root` |
| --- | --- |
| `rust` | `crates/lightwell-core/fixtures` |
| `toml` | `null` (highlighting only; the Rust pack registers the tokenizer) |
| `web` | `crates/lightwell-core/fixtures/web-sample` |
| `python` | `crates/lightwell-core/fixtures/python-sample` |
| `go` | `crates/lightwell-core/fixtures/go-sample` |
| `dotnet` | `crates/lightwell-core/fixtures/dotnet-sample` |
| `php` | `crates/lightwell-core/fixtures/php-sample` |
| `ruby` | `crates/lightwell-core/fixtures/ruby-sample` |
| `jvm` | `crates/lightwell-core/fixtures/jvm-sample` |
| `swift` | `crates/lightwell-core/fixtures/swift-sample` |
| `cpp` | `crates/lightwell-core/fixtures/cpp-sample` |
| `config-infra` | `crates/lightwell-core/fixtures/config-infra-sample` |

Rust uses the fixtures directory itself because the Cargo samples, including `no-cargo-workspace`, live there.

Go is a complete small fixture. `go.mod` declares `module example.com/go-sample`. The tree is `main.go`, `api/api.go`, and `util/util.go`. `src/go-modules.test.ts` and `crates/lightwell-core/src/go_source.rs` both discover that tree and expect the `api` package, the `util` import, and the `Greet` symbol. The Rust test also runs `extract_cargo_map` on it and expects `language` `go` plus a `depends_on` edge.

Put a new language's inputs in `crates/lightwell-core/fixtures/<id>-sample/` and set `fixtures.root` to that path. Include the project marker the discover function requires, and the source files the tests name.

## Add a language end to end

External routing can stop at a manifest. A language that extracts facts or highlights source follows the Go pack and lands on by default: add it to `BUILTIN_LANGUAGE_PACKS`. There is no per-language flag.

Extraction is not dispatched from the manifest. `extract_cargo_map` in `crates/lightwell-core/src/extract.rs` calls each discover function from `map_workspace`. The TypeScript mirror does the same in two places in `src/extract/cargo.ts`: the Cargo branch of `extractCargoMap`, and `extractWithoutCargo` for a folder with no `Cargo.toml`. `extractWorkspaceMap` only calls the Rust pack's `workspaceExtractor`, which is `extractCargoMap`. Until those call sites run the new discover function, maps will not contain the new blocks.

A folder with no `Cargo.toml` opens only when a project marker is found. Rust `project_manifest` checks `PROJECT_MANIFESTS` in `extract.rs` (`Cargo.toml` is first) and then scans the directory for a .NET project file, a config/infra file, or a `*.xcodeproj`. TypeScript `extractCargoMap` checks `Cargo.toml` before `namedProjectMarkers`, and `nonCargoProjectMarker` scans for those same extra files. Go opens on its own because `go.mod` is on both marker lists. A language that should open a folder by itself needs its marker on both lists.

### 1. Pack object and hook names

Add `src/languages/packs/<id>.ts` and append it in `src/languages/builtin-packs.ts`. Built-in manifests are validated together. A conflict between two built-ins fails the catalog load in both `builtin_language_pack_manifests` and `createLanguagePackRegistry`. A user or workspace manifest is different: packs loaded earlier stay, and the conflicting manifest becomes one error entry.

Add the id to `BuiltinLanguagePackId` in `src/languages/language-pack.ts` and to `BUILTIN_IDS` in `src/languages/manifest.ts`. Add a `kind` to the `LanguagePackExtractor` union. Go's kind is `go-module`, with `moduleId` `extract/go-modules` and `coreSourceModule` `lightwell_core::go_source`.

Add the same strings to the Rust hook tables in `crates/lightwell-core/src/language_pack.rs`:

- highlighter hook: the pack id
- source hook: the extractor `kind`
- workspace hook: the pack id, only when the pack sets `workspaceExtractor`

`builtin_language_pack_manifests` validates the generated catalog with those tables. A new hook missing from the table fails that load.

Register a Monarch tokenizer from `src/languages/highlighters/<id>.ts` and set `registerHighlighter`. Go's registrar returns immediately when Monaco already has language id `go`.

### 2. Extract on both sides

Add the Rust module next to `crates/lightwell-core/src/go_source.rs`, declare it in `crates/lightwell-core/src/lib.rs`, and call it from `map_workspace`. Add the TypeScript mirror under `src/extract/` and call it from the Cargo branch of `extractCargoMap` and from `extractWithoutCargo`.

Each discover function decides when a tree is in scope:

| Discover function | When it extracts |
| --- | --- |
| `discover_go_packages` | A root `go.mod` is present. A missing `go.mod` becomes an empty package list. `vendor/` and `testdata/` are skipped. |
| `discover_python_modules` | `.py` and `.pyi` files are walked either way. `discover_python_project` reads `pyproject.toml`, then `setup.cfg`, then `setup.py`. |
| `discover_web_modules` | Web sources are walked with no project marker. |
| `discover_php_packages` | A root `composer.json` is present. Otherwise the list is empty. |
| `discover_ruby_packages` | A root `Gemfile` is present. Otherwise the list is empty. |
| `discover_cpp_targets` | A root `CMakeLists.txt` is present. Otherwise the list is empty. |
| `discover_swift_targets` | `Package.swift` or a `*.xcodeproj` is present. Otherwise the list is empty. |
| `discover_jvm` | A `pom.xml` or Gradle build file is present. Otherwise the workspace is empty. |
| `discover_dotnet` | Walks `.sln`, `.csproj`, `.vbproj`, `.cs`, and `.vb`. |
| `discover_config_infra` | Walks YAML, Terraform, and Dockerfile paths. YAML files with no recognized entities are dropped. |

Module blocks store `language` on the fact. JSON omits that field when the value is `rust` (`is_default_module_language` in `crates/lightwell-core/src/facts.rs`). Every other language is written through. Record the value in the `module` bullet of [`schema.md`](schema.md). Go writes `go`. C# and VB write `csharp` and `vb`. Java and Kotlin file blocks write `java` and `kotlin`.

Commit-diff symbol ranges are also explicit. `symbol_spans` in `crates/lightwell-core/src/diff.rs` calls the language parser for `.py`, `.pyi`, `.go`, `.php`, `.rb`, `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.cs`, and `.vb`. Other extensions get no symbol spans. A new language that should highlight changed symbols adds a branch there.

### 3. Tests

Follow the Go tests, with literal expected names from the fixture:

- `src/go-modules.test.ts` discovers `crates/lightwell-core/fixtures/go-sample`, expects `example.com/go-sample/api`, an import of `example.com/go-sample/util`, and a `Greet` symbol. A second test builds a temporary Cargo crate plus `go.mod` and expects `extractCargoMap` to emit `language: "go"` blocks.
- `go_source.rs` tests the same fixture, including the `depends_on` edge from the `api` file to the `util` `Label` symbol. A separate test parses an inline source with a non-ASCII comment and still finds the import.
- `src/language-registry.test.ts` expects the new id, Monaco id, extractor kind, and `fixtures.root`. It also expects `BUILTIN_LANGUAGE_PACKS.length` to be 12.
- The Rust test `built_in_toml_manifest_uses_v1_schema` expects `builtin_language_pack_manifests()` to return 12 manifests. Update that count in the same change.

Python and config-infra also compare a full Rust CLI map with `extractCargoMap`:

```sh
npm run check:python-parity
npm run check:config-infra-parity
```

Other languages do not have a parity script. Their fixture tests on both sides are the check. `npm run check:rust-map-parity` compares Rust workspace maps and is unchanged by a non-Rust pack.

Run the pack gate, then the suites CI runs:

```sh
npm run check:language-packs
npm test
cargo test -p lightwell-core --lib --locked
cargo test -p lightwell-app --bin lightwell --locked
```

`npm test` includes `src/*-modules.test.ts` and `src/language-registry.test.ts`. A settings-catalog change is covered by `npm run test:e2e` (`e2e/language-packs.spec.ts`), which installs the bundled `demo` pack through Settings.

### 4. External pack only

For a routing-only pack, skip the extractor steps. Use `null` hooks unless the manifest names a hook from the tables above. Put the manifest in a user directory or in `<workspace>/.lightwell/language-packs/`. To show it in Settings, add `resources/language-packs/<id>/language-pack.json`, an entry in `language-packs/catalog.json`, and keep any workspace copy deep-equal when the parity script should watch it.

`schemaVersion` stays 1 until the format changes. A new format needs a new parser branch in both languages, a new JSON schema, and a catalog that still validates. Do not reuse a version 1 field for a different meaning.
