# Map schema

Facts and annotations use schema version `1`. The extractor writes only a facts file. The annotation overlay adds descriptions and hand-picked feature groups without changing extractor output.

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
- `module`: a Rust module reached from a library or binary target. The block records the declaration path, compile attributes, and whether its source file could be resolved.
- `cargo_feature`: a feature declared by a workspace package.

The extractor adds a `contains` connection from each parent to each child. It adds a `depends_on` connection for each internal normal or build path dependency. It omits development dependencies because they describe test/build tooling rather than the shipped workspace graph. `groups` and `stats` are derived from these facts.

## Annotation overlay

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

## Changed annotations

The viewer marks a fact block changed when `blocks[id].sourceFingerprint` differs from its current fact fingerprint. A feature is changed when a member disappeared or any saved member fingerprint differs from the current map. The facts and overlay stay separate, so extraction does not remove annotations when source modules change.
