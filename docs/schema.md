# Map schema

Facts files, preview annotation overlays, and project notes use schema version `1`. The extractor writes only a facts file. A preview annotation overlay adds descriptions and hand-picked feature groups without changing extractor output.

## Facts file

```json
{
  "schemaVersion": 1,
  "project": { "id": "workspace:scorecard", "name": "Scorecard", "rootPath": "." },
  "blocks": [],
  "connections": [],
  "groups": [],
  "stats": {}
}
```

Each block has a stable `id`, a label, a discriminant `type`, a `parentId`, `children`, a repository-relative `sourcePath`, and a SHA-256 `fingerprint`. Block types are:

- `workspace`: Cargo workspace root.
- `crate`: Cargo workspace member, package version, and Cargo description.
- `app`: a Cargo binary target and its entry file.
- `module`: a source module. Rust modules are reached from a library or binary target and record the declaration path, compile attributes, and whether the source file could be resolved. Python modules (`.py` and `.pyi`) record `language` as `python`, import lines in `cfgAttributes`, and top-level classes and functions as child modules. When `pyproject.toml`, `setup.cfg`, or `setup.py` is present, a project module and console/entry-point apps are added; resolved in-workspace imports become `depends_on` edges. A Python file that is not valid UTF-8 is an unresolved module and does not stop extraction. Go modules record `language` as `go` for packages, files, and top-level functions, methods, and types when `go.mod` is present. C# and VB.NET modules record `language` as `csharp` or `vb`. Project, namespace, file, type, and method blocks use `cfgAttributes` such as `project`, `namespace`, `file`, `class`, `partial class`, `struct`, `record`, `interface`, `enum`, `module`, and `method`. A source file that is not valid UTF-8 is an unresolved file block and does not stop extraction. Rust modules omit `language`.
- `cargo_feature`: a feature declared by a workspace package.

The extractor adds a `contains` connection from each parent to each child. It adds a `depends_on` connection for each internal normal or build path dependency. It omits development dependencies because they describe test/build tooling rather than the shipped workspace graph. `groups` and `stats` are derived from these facts.

## Preview annotation overlay

```json
{
  "schemaVersion": 1,
  "projectId": "workspace:scorecard",
  "blocks": {
    "crate:sc-core": {
      "description": "Scorecard model, configuration, and score formulas.",
      "kind": "CRATE",
      "status": "ready",
      "sourceFingerprint": "<sha256 from the matching facts block>"
    }
  },
  "features": [],
  "groups": []
}
```

Each fact block gets a 1–3 sentence description, a visual kind (`APP`, `CRATE`, `MODULE`, or `FEATURE`), and a status (`ready`, `wip`, or `deprecated`). `sourceFingerprint` records which source version the description covers.

Overlay `features` are virtual feature boxes. Each one has a description, status, a list of fact block IDs, and a fingerprint for each member. These boxes power the feature strip at the bottom of the viewer. Overlay `groups` arrange feature IDs into selectable strips.

## Project notes

The CLI stores project notes in `.lightwell/notes.json`, creating the directory and file on the first saved note:

```json
{
  "schemaVersion": 1,
  "notes": {
    "crate:lightwell-core": {
      "text": "Review output serialization.",
      "sourceFingerprint": "<sha256 from the matching facts block>"
    }
  }
}
```

The `notes` object is keyed by stable fact block IDs. `lightwell notes list` compares each saved fingerprint with the current extracted map and marks missing or changed blocks stale. It does not delete stale notes. `lightwell notes set <block-id> <text...>` records the current fingerprint, and `lightwell notes rm <block-id>` removes only that note.

## Changed notes

The viewer marks a fact block changed when `blocks[id].sourceFingerprint` differs from its current fact fingerprint. A feature is changed when a member disappeared or any saved member fingerprint differs from the current map. Facts, preview annotations, and project notes stay separate, so extraction does not remove notes when source modules change.
