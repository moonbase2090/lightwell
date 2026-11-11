# Files in a block

The source inspector offers **Source file** when an opened block owns multiple mapped files. Choosing a file loads its mapped block in the same inspector. The selector keeps the original block's file list until another block is opened normally.

`blockSourceFiles(ownerId, blockById)` returns `{ blockId, path }` entries for the owner and its descendants. It deduplicates paths, prefers the owner's primary source, and sorts the remaining paths. Dependencies and unmapped files are excluded. The map owns containment; the viewer does not scan directories or send arbitrary paths to the backend.

The inspector adds a `{ kind: "file", ownerId, blockId }` navigation target alongside normal block and definition targets. The file selector keeps `ownerId` while changing `blockId`. Normal selection and definition jumps start a new owner list. Existing inspection, notes and external-editor actions use that active block ID, so they refer to the displayed file. Commit diffs retain their existing single-file navigation.

An alternative backend file-list command would duplicate containment already present in the map. Accepting an arbitrary selected path would add another source-access boundary. Navigating existing mapped block IDs reuses the current confined resolver and preserves source positions without a new protocol or schema field.

The list covers files represented by the owner or its descendants. Multiple declarations in one physical file produce one choice. Files absent from the map remain absent from the inspector.
