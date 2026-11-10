# Language pack authoring

A version 1 language pack is a JSON manifest. It tells Lightwell which paths belong to the pack and which Monaco language id to use for those paths. It is data. Installing one copies the manifest and does not load JavaScript, native code, or any companion file.

Lightwell checks the same manifest in two places:

- The TypeScript parser in `src/languages/manifest.ts` (`parseLanguagePackManifest`). The Node loader, the TOML built-in, and the desktop catalog parser all use it.
- The Rust parser in `crates/lightwell-core/src/language_pack.rs` (`read_language_pack_manifest` and `validate_language_pack_manifest`). The desktop app validates a pack with this before it installs or publishes the pack.

A manifest has to satisfy both. The machine-readable shape is [language-pack.schema.json](language-pack.schema.json). Installing and reloading packs is covered in [language-packs.md](language-packs.md).

The worked example at the bottom of this guide is parsed by `src/language-pack-loader.test.ts`. Changing the example without updating that test fails `npm test`.

## Manifest format

Every field below is required. Unknown fields are rejected on the manifest and on `monaco` and `extractors`. Nullable fields must be present and set to `null`; omitting them is an error. `schemaVersion` is the number `1`, not the string `"1"`.

| Field | Shape |
| --- | --- |
| `schemaVersion` | `1` |
| `id` | Pack id. A lowercase letter, then lowercase letters, digits, or hyphens. |
| `packVersion` | A version string. See the version rule below. |
| `extensions` | Array of lowercase extensions, each starting with a dot. May be empty. |
| `basenames` | Array of exact file names, such as `Ledgerfile`. May be empty. |
| `basenamePrefixes` | Array of file-name prefixes, such as `Ledgerfile.`. May be empty. |
| `monaco.id` | Default Monaco language id when no override matches. |
| `monaco.highlighter` | Host highlighter hook name, or `null`. |
| `monaco.byExtension` | Object mapping an extension to a Monaco language id. |
| `monaco.byBasename` | Object mapping a declared basename to a Monaco language id. |
| `monaco.byBasenamePrefix` | Object mapping a declared prefix to a Monaco language id. |
| `extractors.source` | Host source-extractor hook name, or `null`. |
| `extractors.workspace` | Host workspace-extractor hook name, or `null`. |
| `fixtures` | Repository-relative fixture directory, or `null`. |

At least one of `extensions`, `basenames`, and `basenamePrefixes` must contain an entry. The lists may contain empty arrays individually. The TOML built-in is the checked-in JSON example of a highlight-only pack: `src/languages/manifests/toml.language-pack.json`. The other built-ins are TypeScript objects under `src/languages/packs/`. `npm run generate:language-packs` writes them to `src/languages/manifests/builtin.language-packs.json`, which the Rust loader embeds.

`monaco.byExtension` keys use the same extension syntax as `extensions`, but they do not have to be listed there. The web pack maps `.json` and does not list `.json` as an extension; `package.json` is claimed with a basename. Basename and prefix override keys must match a name declared on this pack. Matching is case-insensitive. The TypeScript parser stores those override keys in lowercase (`Ledgerfile` is stored as `ledgerfile`). The Rust parser keeps the spelling from the file, and the desktop viewer then runs the TypeScript parser, so a pack that reaches the viewer has lowercase keys.

`monaco.id` and the override values are not checked against a list of registered languages. With `monaco.highlighter` set to `null`, the pack does not register a tokenizer. Use `plaintext`, or a language id a host highlighter already registers, when the pack only routes files.

## Validation rules

These are the rules both parsers enforce. The error text differs between them. The manifests they accept differ in the two places noted below: the desktop catalog's version pattern, and the first character of an extension. Rust allows `.`, `+`, or `-` immediately after the leading dot; the JSON Schema and the TypeScript parser do not. Write extensions that pass the schema.

### Identity

`id` must match `^[a-z][a-z0-9-]*$`. `ledger` and `config-infra` are valid. `Ledger`, `1ledger`, `ledger_pack`, and `../ledger` are not. The desktop catalog installer uses the same pattern for a bundled pack id (`validate_catalog_id` in `crates/lightwell-app/src/language_packs.rs`).

`packVersion` in the manifest parsers is three dot-separated numeric parts, with an optional pre-release suffix of letters, digits, dots, and hyphens: `1.2.3` or `1.2.3-beta.1`. A leading `v`, a `+` build suffix, or a fourth numeric part is rejected. The desktop catalog parser is stricter. `isLanguagePackVersion` in `src/map-sources/tauri-types.ts`, and the Settings catalog in `src/language-pack-catalog.ts`, accept only `MAJOR.MINOR.PATCH` with no leading zeros and no suffix. A pre-release version can pass the manifest parsers and still be rejected when the desktop viewer reads the catalog. Packs that are installed in the desktop app should use a plain version such as `1.0.0`.

### Routing lists

An extension matches `^\.[a-z0-9][a-z0-9.+-]*$`. `.ledger`, `.ldg`, and `.tfvars` are valid. `ledger`, `.Ledger`, `.`, and `..` are not. The JSON Schema and the TypeScript parser require the first character after the dot to be a letter or digit. Follow that rule. Duplicate extensions in one pack are an error.

A basename or prefix must be a non-empty string and must not contain `/` or `\`. The value is the file name only, not a path. Duplicates inside one pack are compared case-insensitively, so `Ledgerfile` and `ledgerfile` conflict. `ÄFile` and `äfile` also conflict. A pack may declare a basename that starts with its own prefix. Two prefixes on the same pack may overlap.

### Monaco overrides

Each override value must be a non-empty string. A `byBasename` or `byBasenamePrefix` key that is not one of the pack's declared names is an error (`LedgerFile` does not match a declared `Ledgerfile` only when the case-insensitive spelling differs; `Ledgerfile` does match `Ledgerfile`). `byExtension` keys are validated as extensions and are not required to appear in `extensions`.

### Hooks

`monaco.highlighter`, `extractors.source`, and `extractors.workspace` are `null` or the name of a hook the host already installed. An empty string is a validation error. A name the host does not install is rejected. Rust reports that during manifest validation (`hook "…" is not installed`). TypeScript `parseLanguagePackManifest` only checks that the string is non-empty; `languagePackFromManifest` resolves it. The Node loader calls that with an empty hook table unless the caller passes one, so any non-null hook becomes an `unknown-hook` catalog error under `loadLanguagePacks()`. The desktop activator passes the built-in table from `src/language-pack-activation.ts`.

Installed names, from `HIGHLIGHTER_HOOKS`, `SOURCE_EXTRACTOR_HOOKS`, and `WORKSPACE_EXTRACTOR_HOOKS` in `crates/lightwell-core/src/language_pack.rs`:

| Field | Installed names |
| --- | --- |
| `monaco.highlighter` | `config-infra`, `cpp`, `dotnet`, `go`, `jvm`, `php`, `python`, `ruby`, `rust`, `swift`, `web` |
| `extractors.source` | `config-infra-module`, `cpp-module`, `dotnet-module`, `go-module`, `jvm-module`, `php-module`, `python-module`, `ruby-module`, `rust-workspace`, `swift-module`, `web-module` |
| `extractors.workspace` | `rust` |

Highlighter and workspace names are built-in pack ids. Source names are extractor kinds (`rust-workspace`, `python-module`, and the rest). The TOML pack's highlighter is `null`; `toml` is not a hook name. The Rust pack registers the TOML tokenizer itself. Naming a hook reuses that host implementation. A version 1 manifest cannot add a new extractor or highlighter.

### Fixtures field

`fixtures` is `null` or a string that contains a non-whitespace character. The loader stores it as `LanguagePack.fixtures.root` and does not open the directory, check that it exists, or copy it. Built-in packs set a repository-relative path. External packs in this repository set `null`.

### Conflicts

Packs do not override each other. Built-ins load first, then user packs, then workspace packs. User and workspace manifests in one directory are loaded in file-name order. The first pack to claim an id, extension, basename, or basename prefix keeps it. A later pack that collides is a catalog error, and the earlier pack stays active.

Conflicts, compared case-insensitively:

- The same `id`.
- The same extension.
- The same basename.
- A basename that starts with another pack's basename prefix.
- Two basename prefixes where either starts with the other.

The message has the form `Language pack <field> conflict for "<value>" between <first> and <second>.` A built-in manifest that fails validation or conflicts with another built-in aborts the whole load. An external failure does not.

### Catalog errors

A bad external manifest becomes one catalog entry. The other packs still load.

| `code` | When |
| --- | --- |
| `read` | The manifest path could not be read. An unreadable pack directory is reported this way too. |
| `parse` | The file is not the JSON object the parser expects, including a missing field in Rust. |
| `validation` | A field breaks the rules above. |
| `unknown-hook` | A hook name is not installed. |
| `conflict` | The pack collides with one that is already loaded. |

A missing pack directory is skipped, not reported.

## How to run validation

There is no separate `lightwell` subcommand for a manifest. Validation runs through the parsers and the tests that call them.

From the repository root, after `npm ci`:

```sh
npm test
npm run test:language-packs
npm run check:language-packs
```

`npm test` includes `src/language-pack-loader.test.ts`, `src/language-pack-catalog.test.ts`, `src/language-pack-settings.test.ts`, `src/language-registry.test.ts`, and the catalog case in `src/tauri-map-source.test.ts`.

`npm run test:language-packs` runs the loader tests, including the check that this guide's example parses and routes.

`npm run check:language-packs` (`scripts/check-language-pack-parity.mjs`) does four things:

1. Runs `npm run generate:language-packs` and fails if `src/languages/manifests/builtin.language-packs.json` changes.
2. Asserts that `resources/language-packs/demo/language-pack.json` and `crates/lightwell-core/fixtures/language-pack-sample/.lightwell/language-packs/demo.language-pack.json` are the same JSON value.
3. Runs `npm run test:language-packs`.
4. Runs `cargo test -p lightwell-core --lib language_pack::tests --locked` and `cargo test -p lightwell-app --bin lightwell language_packs --locked`.

After an intentional edit to a built-in pack object, regenerate the catalog and commit it:

```sh
npm run generate:language-packs
git add src/languages/manifests/builtin.language-packs.json
```

The desktop command `validate_language_pack` reads a manifest through the Rust parser. A catalog source is a bundled id under the app resource directory `language-packs/<id>/language-pack.json`. A path source must be absolute; a directory means `language-pack.json` inside it. Install copies that file into the application config directory under `language-packs` and refuses to replace an existing file unless replacement was requested. The viewer exposes these commands when the app is built with `VITE_ENABLE_LANGUAGE_PACKS=true` (`src/map-sources/tauri.ts`). The parsers and tests run either way.

## Where the loader looks

The loader reads built-ins from the generated catalog. It then discovers external manifests in two directories:

- User packs: `LIGHTWELL_LANGUAGE_PACKS_DIR` when that variable is set. Otherwise `~/.lightwell/language-packs`, using `HOME` or `USERPROFILE`. The desktop app passes its application config directory instead of this default.
- Workspace packs: `<repository>/.lightwell/language-packs`.

In each directory, a file whose name ends with `.language-pack.json` is a manifest. An immediate subdirectory that contains `language-pack.json` is a manifest. Deeper files are ignored. Both of these are accepted:

```text
.lightwell/language-packs/demo.language-pack.json
.lightwell/language-packs/demo/language-pack.json
```

The bundled Settings listing is a different file, `language-packs/catalog.json`. Each entry has `id`, `packVersion`, `description`, and `extensions`. That extension pattern does not allow a dot after the first character, and the listing is not a second copy of the manifest. The installable demo manifest itself is `resources/language-packs/demo/language-pack.json`.

## Fixture layout

`fixtures` and the on-disk sample that exercises discovery are different things.

The discovery sample is a workspace root, not a `fixtures` path. Its manifest sets `fixtures` to `null`. The loader test opens this directory as `repositoryPath`:

```text
crates/lightwell-core/fixtures/language-pack-sample/
  .lightwell/language-packs/demo.language-pack.json
  src/example.demo
```

`src/example.demo` contains the text `sample external language pack`. The loader test also routes the path `nested/DemoFile` through the manifest's basename. That path is not a file in the sample. The bundled copy of the manifest must stay identical to the workspace copy; the parity script compares them.

Built-in `fixtures` values are repository-relative directories that extractor tests open themselves. The current roots are:

| Pack | `fixtures` |
| --- | --- |
| `rust` | `crates/lightwell-core/fixtures` |
| `toml` | `null` |
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

Each sample is a small project of the kind that pack extracts:

- Rust points at the whole fixtures tree. Extraction tests open `no-cargo-workspace/`, a Cargo workspace with `crates/app` and `crates/shared`.
- Web is a Next.js and Vite-shaped tree: `package.json`, `tsconfig.json`, `vite.config.ts`, `next.config.mjs`, `app/`, `pages/`, `src/`, HTML, CSS, and SCSS.
- Python has `pyproject.toml`, `loose.py`, and `sample_pkg/` including `api.py`, a package `__main__`, and `types.pyi`. `notes.txt` sits beside them and is not a Python path.
- Go has `go.mod` (`module example.com/go-sample`) plus `main.go`, `api/api.go`, and `util/util.go`.
- .NET has `Sample.sln`, a C# project, and a VB project. `bin/` and `obj/` files are present so tests can see them skipped.
- PHP has `composer.json`, `artisan`, `app/Models`, `app/Http/Controllers`, and `vendor/Skipped.php`.
- Ruby has a `Gemfile`, `blog.gemspec`, `config/application.rb`, `bin/rails`, `app/models`, `app/controllers`, and skipped files under `vendor/`, `tmp/`, and `log/`.
- JVM has a Maven and Gradle multi-module tree (`pom.xml`, `settings.gradle.kts`, `app/`, `lib/`).
- Swift has `Package.swift` and `Sources/Demo/main.swift`.
- C/C++ has `CMakeLists.txt` and `src/` sources and a header.
- Config and infrastructure has a `Dockerfile`, Compose and Kubernetes YAML, a GitHub workflow, and Terraform files.

TOML has no fixture directory. Cargo-manifest highlighting is registered by the Rust pack.

## Tests

Loader and registry tests lock the manifest rules. Extractor tests lock a built-in sample. They assert concrete facts from the fixture; they do not compare a file to itself.

- `src/language-pack-loader.test.ts` rejects an extension without a leading dot, requires the nullable fields, treats `ÄFile` and `äfile` as a basename conflict, keeps a built-in when a user pack reuses `.rs` or the id `rust`, loads a valid user manifest, loads `language-pack-sample`, and parses the example in this guide.
- `crates/lightwell-core/src/language_pack.rs` tests the same validation and conflict cases, and loads the sample workspace pack through `load_language_packs_with_builtins`.
- `src/language-registry.test.ts` checks path routing for every built-in and checks that each pack's `fixtures.root` is the path in the table above.
- `src/language-pack-catalog.test.ts` checks `language-packs/catalog.json`: the demo entry, duplicate ids, a rejected id, and numeric version comparison (`1.10.0` is newer than `1.9.9`).
- `src/python-modules.test.ts` opens `crates/lightwell-core/fixtures/python-sample` and expects `sample_pkg.api` to import `json`, to import `run` from `.nested.worker`, and to define `load_widget`, `Widget`, and `refresh`. The other built-in packs follow that pattern in their extractor tests. `npm run check:python-parity` compares the Rust and TypeScript maps for the shared Python fixtures.

Routing behavior that those tests rely on, from `src/languages/registry.ts`:

- The file name is the last segment of a `/` or `\` path. `C:\books\year.ledger` is the basename `year.ledger`.
- A basename or prefix match outranks every extension match, including an extension on the same pack.
- Otherwise the longest matching extension wins. `.tsx` beats `.ts`. An extension of equal length does not replace one that already matched.
- Comparison is case-insensitive.
- Monaco id lookup checks the exact basename, then a matching prefix, then the extension, then `monaco.id`. For a path with no pack, the Monaco id is `rust`.
- The extension used for that Monaco lookup is the slice from the last dot. The web pack additionally rewrites `package.json`, `tsconfig.json`, `jsconfig.json`, `vite.config.*`, and `next.config.*` before the lookup. That rewrite is in the registry, not in the manifest format. An external pack does not get it.

## Worked example

This pack routes a fictional ledger language. It claims two extensions, one basename, and one prefix. Hooks and fixtures are `null`, which is what an external routing pack should ship. The Monaco ids are distinct so a reader can see which rule matched. They do not register grammars, because `highlighter` is `null`.

`src/language-pack-loader.test.ts` reads the `json language-pack-example` fence, parses it with `parseLanguagePackManifest`, and checks the routes in the table.

```json language-pack-example
{
  "schemaVersion": 1,
  "id": "ledger",
  "packVersion": "1.0.0",
  "extensions": [".ledger", ".ldg"],
  "basenames": ["Ledgerfile"],
  "basenamePrefixes": ["Ledgerfile."],
  "monaco": {
    "id": "plaintext",
    "highlighter": null,
    "byExtension": {
      ".ledger": "json"
    },
    "byBasename": {
      "Ledgerfile": "yaml"
    },
    "byBasenamePrefix": {
      "Ledgerfile.": "dockerfile"
    }
  },
  "extractors": {
    "source": null,
    "workspace": null
  },
  "fixtures": null
}
```

| Path | Pack | Monaco id | Why |
| --- | --- | --- | --- |
| `books/year.ledger` | `ledger` | `json` | Extension `.ledger`. |
| `books/year.ldg` | `ledger` | `plaintext` | Extension `.ldg` has no override, so `monaco.id` is used. |
| `C:\books\year.ledger` | `ledger` | `json` | The basename is the segment after the backslash. |
| `Ledgerfile` | `ledger` | `yaml` | Exact basename. The parser stores the override key as `ledgerfile`. |
| `LEDGERFILE` | `ledger` | `yaml` | Basename matching is case-insensitive. |
| `nested/Ledgerfile.production` | `ledger` | `dockerfile` | The file name starts with `Ledgerfile.`. |
| `dir/Ledgerfile.ledger` | `ledger` | `dockerfile` | The prefix match outranks the `.ledger` extension on the same pack. |
| `src/lib.rs` | `rust` | `rust` | A built-in that this pack does not claim. |
| `README.md` | none | `rust` | No pack matches. Monaco still falls back to `rust`. |

To try the manifest as a workspace pack, put it at `.lightwell/language-packs/ledger.language-pack.json` in a repository and reload packs. Pick an id, extension, basename, and prefix that no built-in or other pack already claims. `.rs`, `Dockerfile`, and `Dockerfile.` are already taken.
