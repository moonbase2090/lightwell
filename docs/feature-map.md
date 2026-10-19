# Feature map

Every user-facing control and visible state in the viewer, with a stable ID the Playwright suite in stage 2 will cover. Each row names where the control lives, what the user sees when it works, and whether the web build can exercise it. Behavior below comes from the viewer source; a row that says "Behavior to confirm" marks a place where the code leaves the intended behavior unclear instead of guessing it.

## How to read this map

IDs group by area: `APP` shell, `MAP` graph canvas and map toolbar, `TREE` vertical file tree, `INSP` details and tree inspectors, `EDIT` source inspector and code editor, `DIFF` commit diff, `NOTES` project notes, `SET` settings, and `SPL` splitters. Numbers run in order inside each prefix with no gaps. The Coverage section at the end will map each test title to the IDs it proves.

## Browser or desktop

The entry point picks the data source at startup. A Tauri window gets the desktop source; anything else gets the fixture source, which serves the checked-in Prismattyc and Scorecard maps with no backend. The fixture source has no editor, no git history, no folder picker, and no file watcher. Its project notes live in page memory and follow the same build-time opt-out as the desktop app.

- **Browser** means the control works in the Vite web build on a fixture map with no Tauri backend. The Playwright suite can cover it.
- **Desktop-only** means the control needs Tauri: the folder dialog, source reads from disk, notes written to disk, git history, the updater, or opening a file in another editor. The web suite cannot cover these; the last sections collect them.

Persistence splits two ways in the code. Device settings (theme, text sizes, word wrap, the word-wrap shortcut, and the update-check choice) save to `localStorage` for the whole device. Map choices save per workspace, also in `localStorage`, keyed by workspace ID: map view, tree orientation, map depth, file-tree zoom, and both splitter sizes. Project notes persist on disk in the desktop app and in page memory in the web build.

## App shell

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| APP-01 | Project selector | Top bar, `PROJECT` select in `App` | Lists every map the source offers and switches the whole viewer to the chosen one. The web build lists Prismattyc and Scorecard. Changing it clears any open source inspector. | Browser |
| APP-02 | Open workspace button | Top bar in `App`, desktop builds only | Opens the system folder dialog titled "Open a Rust workspace". Picking a folder with a `Cargo.toml` builds its map, adds it to the top of the project list, and selects it. Cancelling changes nothing. The button reads "Opening…" while the dialog and load run, and the first-run screen shows the same action as "Choose Rust workspace". | Desktop-only |
| APP-03 | Search input | Top bar in `App`, placeholder "Search blocks and features…" | Typing filters the map's blocks and feature groups. Escape clears the text. Enter picks the first match and moves the map to it. The field shows a Cmd/Ctrl+K hint. | Browser |
| APP-04 | Search results list | Dropdown under the search input in `App` (`SearchResults`) | Shows up to 8 matches with kind mark, label, path, and status. Choosing one selects it, clears the search, and centers it on the map. An empty result reads "No matching blocks". | Browser |
| APP-05 | Focus search shortcut | Global key handler in `App` | Cmd+K or Ctrl+K moves focus to the search input from anywhere in the window. | Browser |
| APP-06 | Settings button | Top bar in `App` | Opens the Settings dialog (see the `SET` rows). | Browser |
| APP-07 | Local map indicator and status bar | Top bar and bottom status bar in `App` | The top bar shows a "LOCAL MAP" indicator. The status bar states the map is local and source-backed, names the project, and gives the mapped crate count. Both are static text with no action. The status bar also says annotations stay in a separate overlay and names the metadata command even in the web build, where no command runs. | Browser |
| APP-08 | Project summary row | Under the top bar in `App` | Shows the project name, a "ready" pill, the annotation description when one exists, and totals for blocks, connections, modules, and a count labelled "notes". That last count is the number of annotation features, not saved project notes. Behavior to confirm: the label says "notes" for the feature count. | Browser |
| APP-09 | Loading workspace states | Full-screen card in `App` (`MapSourceState`) | While maps or a map load, the user sees a titled card such as "Loading workspaces", "Loading workspace map", or "Selecting a workspace" with a matching message and no map. The fixture build passes through these states quickly. | Browser |
| APP-10 | Map list and load error states | Full-screen card in `App` (`MapSourceState`) | If listing maps fails, the card reads "Could not load recent workspaces" with the error as an alert. If one map fails, it reads "Could not open this Rust workspace". Desktop builds also offer the folder action on these cards. The fixture source does not fail on its two maps, so a browser test needs a failing source to reach these states. | Browser |
| APP-11 | Empty workspace state | Full-screen card in `App` (`MapSourceState`) | With no maps at all, the card reads "Open a Rust workspace" and asks for a folder with a `Cargo.toml`. The web build always has two fixture maps, so this state only appears in the desktop app before any workspace opens. | Desktop-only |
| APP-12 | Workspace error banner | Banner under the top bar in `App` | Shows a workspace, live-refresh, or note-editor failure as an alert with a Dismiss button that clears it. Every path that sets this message sits behind the desktop source, so the banner does not appear in the web build. | Desktop-only |
| APP-13 | Theme on the shell | Root element in `App` | The resolved theme (dark, light, or blueprint) applies to the whole shell and both code editors. "Follow system" follows the operating system's light or dark setting and updates live when it changes. New installs default to blueprint. See SET-01. | Browser |
| APP-14 | Live map refresh | Map loading in `App`, desktop builds only | When files change in the open workspace, the desktop source pushes a fresh map. The viewer swaps it in, keeps the current viewport, and clears any workspace error. A failed push or watcher shows in APP-12 instead. | Desktop-only |

## Map canvas and toolbar

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| MAP-01 | Modules / Files toggle | Canvas watermark bar in `App`; a second copy sits in the file-tree toolbar (TREE-02) | "Modules" shows the block graph. "Files" shows the file tree: indented rows in vertical orientation, folder and file blocks on the graph in horizontal. The choice saves per workspace and defaults to Modules. Switching re-centers on the selected block when it has one. | Browser |
| MAP-02 | Depth control | Canvas watermark bar in `App`; a second copy sits in the file-tree toolbar (TREE-07) | Limits how many levels below the current scope the map draws. Choices run from 1 up to the deeper of the subtree depth and the saved value, capped at 12, plus "All". The default is 2. The choice saves per workspace and also sets how deep the file tree starts expanded. | Browser |
| MAP-03 | Direct children count | Canvas watermark bar in `App` | Reads "N direct children" for the current scope. In Files view it counts the file root's children instead. Display only. | Browser |
| MAP-04 | Breadcrumbs | Map toolbar in `App` | Shows the scope path from the workspace root. Clicking an earlier crumb moves the scope back to it, selects it, and clears feature tracing, hover, the file scope, and any open inspector. In Files view, folder crumbs from the file scope follow the block crumbs and narrow the tree when clicked. | Browser |
| MAP-05 | Rotate tree button | Map toolbar in `App`, Files view only | Switches the file tree between the indented list and the wide graph. The button names the view it will show: "Horizontal" while vertical, "Vertical" while horizontal. The choice saves per workspace and defaults to vertical. | Browser |
| MAP-06 | Connection legend | Map toolbar in `App` | Shows counts of "contains" and "depends on" connections among the blocks currently in scope. When annotation fingerprints no longer match the map, it adds "N changed" with a warning icon. Display only. | Browser |
| MAP-07 | Graph node | Block card on the React Flow canvas (`viewer/BlockNode`) | Shows the block kind, its status pill unless it has no annotation, the label, the last two path segments (or "source path unresolved"), a child count chevron when it has children, and a warning icon when its annotation changed. Clicking selects it; a block with children also becomes the new scope in Modules view. In Files view a click only selects. Nodes do not drag, connect, or multi-select. Enter or Space activates a focused node. | Browser |
| MAP-08 | Node hover tracing | React Flow canvas in `App` and `viewer/layout` (`emphasizeGraph`) | Hovering a node highlights it and its direct neighbours and dims the rest. Hovering a feature card (MAP-13) highlights that feature's member blocks instead. With a commit diff active and nothing hovered, changed blocks stay lit and the rest dim. Moving the pointer away restores the full map. | Browser |
| MAP-09 | Note badge on a node | Block card in `viewer/BlockNode` | A note icon appears on blocks that have a saved project note. Its tooltip previews the note text (trimmed, capped at 280 characters). Clicking it opens the notes dialog for that block without selecting the node. See NOTES-09. | Browser |
| MAP-10 | Canvas controls and fitting | React Flow `Controls` and fit helpers in `App` | Bottom-left controls zoom and fit the graph; the mouse wheel and pinch zoom between 0.12 and 1.7. The graph fits itself when a map loads and after each scope change, framing the scope and its 8 nearest children on wide scopes. Choosing a search result, a changed block, or "Show on map" centers that block instead. Returning to a refreshed map restores the saved viewport. | Browser |
| MAP-11 | Graph preparing and error states | Canvas area in `App` | Before layout finishes, the canvas reads "Preparing graph layout…". If layout fails, it reads "Could not lay out this map: …" with the error. The vertical file tree replaces both states with its rows. | Browser |
| MAP-12 | Feature group tabs | Feature footer in `App` (`FeatureFooter`) | One tab per annotation group, labelled with its feature count. The first group is active by default. Switching tabs clears any active feature tracing. | Browser |
| MAP-13 | Feature cards | Feature footer in `App` (`FeatureFooter`) | Each card shows "FEATURE", a status mark, the feature name, and its block count. Hovering or focusing a card draws connector curves to its member blocks on the canvas and highlights them. A card for a changed feature gets the changed styling. A group with no features reads "No feature notes in this group." | Browser |
| MAP-14 | Feature card selection | Feature footer in `App` (`FeatureFooter`) | Clicking a card selects the feature group itself. The inspector then lists its connected blocks (INSP-04) instead of a single block. | Browser |

## File tree

The tree replaces the graph in Files view with vertical orientation. Its toolbar repeats the view toggle and depth control from the canvas so both stay reachable while the canvas bar is hidden.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| TREE-01 | Filter input | File-tree toolbar in `FileExplorer`, placeholder "Filter symbols..." | Typing keeps every row whose label or source path contains the text, plus all ancestors of a match so it stays in context. Matching ignores case. The row count (TREE-08) updates with the filter. | Browser |
| TREE-02 | Modules / Files toggle (tree copy) | File-tree toolbar in `FileExplorer` | Same action as MAP-01. Behavior to confirm: in this copy the pressed state is fixed, with Files always marked pressed and Modules never, while the canvas copy reflects the real view. | Browser |
| TREE-03 | Expand all | File-tree toolbar in `FileExplorer` | Expands every folder in the tree, ignoring the depth limit. | Browser |
| TREE-04 | Collapse | File-tree toolbar in `FileExplorer` | Collapses every folder so only the root row remains. | Browser |
| TREE-05 | Zoom buttons | File-tree toolbar in `FileExplorer` | "−" and "+" step the row scale by a tenth between 80% and 180%. The middle button shows the current percentage and resets to 100%. The end buttons disable at the limits. The scale saves per workspace and resizes row padding, indent, guides, and chevron size. | Browser |
| TREE-06 | Zoom shortcuts | Global key handler in `FileExplorer` | Ctrl or Cmd with "+", "=", "-", or "_" zooms in or out one step; Ctrl or Cmd with "0" resets to 100%. Plain and Alt-modified keys do nothing. The shortcuts stay inert while a dialog is open. They apply even when focus is outside the tree. | Browser |
| TREE-07 | Depth control (tree copy) | File-tree toolbar in `FileExplorer` | Same control and per-workspace value as MAP-02. Changing it also re-seeds which folders start expanded. | Browser |
| TREE-08 | Row count | File-tree toolbar in `FileExplorer` | Reads "N of M nodes" where N is the rows currently listed after filtering and M is every node in the file tree. Display only. | Browser |
| TREE-09 | Tree rows | File-tree body in `FileExplorer`, role `tree` | Each row indents by level with guide lines and shows a kind badge, label, the last two path segments, and a child count for parents. Clicking selects the row and scrolls it into view; Enter or Space selects a focused row. Selecting a row in vertical view expands its ancestors so it stays visible. A changed row adds "+n −n" counts while a commit diff is active. | Browser |
| TREE-10 | Row expand toggle | Chevron button on each parent row in `FileExplorer` | Expands or collapses that folder without changing the selection. The button label names the action and folder, and the row reports its expanded state. | Browser |
| TREE-11 | Empty filter state | File-tree body in `FileExplorer` | When the filter matches nothing, the body reads "No matching symbols" instead of rows. | Browser |
| TREE-12 | Row kind badges | File-tree rows in `FileExplorer` and `file-tree` (`explorerBadge`) | Badges read FILE for folders, crates, and workspaces; APP for binary targets; FEAT for Cargo features; MOD for modules; and FN, TYPE, or CONST for function, type, and constant symbols in Python, web, Go, and .NET outlines. Display only. | Browser |
| TREE-13 | Only-changed rows | File-tree body in `FileExplorer`, driven from DIFF-06 | With "Only changed" on, the tree keeps only rows on branches that contain a changed block, still honouring the text filter. This needs commit data, so it cannot appear in the web build. | Desktop-only |

## Inspectors

The side panel shows one of three inspectors: block details for the selection, the tree inspector in the vertical file tree, or folder details for a selected folder. Opening source from any of them belongs to the `EDIT` rows.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| INSP-01 | Block details | Side panel in `App` (`DetailsPanel`) | Shows the block kind and type, label, status pill, and description. Missing annotations prompt "Add a description to the annotation overlay." Changed annotations warn "Code changed since this note was written." An unresolved module warns that its declaration has no source file. | Browser |
| INSP-02 | Block stats and facts | Side panel in `App` (`DetailsPanel`) | A grid counts children, incoming connections, outgoing connections, and changed blocks (1 when this block changed, else 0). Below it, crates show package version, binaries show target type, modules show compile conditions, workspaces show member count, and features show the feature name. A SOURCE line gives the path label for the block. | Browser |
| INSP-03 | Child block rows | Side panel in `App` (`DetailsPanel`) | Lists up to 7 child blocks with kind marks; more collapse into "+ N more blocks". Clicking a child selects it and opens it the same way a map click does. When the block has children, an "Open …" button under the list drills into it. | Browser |
| INSP-04 | Feature details | Side panel in `App` (`DetailsPanel`, virtual node) | For a selected feature group, shows the group description and status, a stale warning when changed, and every connected block as a row that selects and opens that block. The path line reads the group's label. | Browser |
| INSP-05 | Folder details | Side panel in `App` (`FolderDetails`) | For a selected folder in horizontal Files view, shows the folder name, its item count, its path, and a row per child that selects that child. | Browser |
| INSP-06 | Tree inspector | Side panel in `FileExplorer` (`TreeInspector`), vertical Files view | Shows the row badge, label, path, direct-child count, and depth. Child rows select the child. A breadcrumb trail under the list selects any ancestor. For a file row, an Open button opens its source (EDIT-01); folders and unmapped rows have no Open button. | Browser |
| INSP-07 | Saved note card | Side panel in `App` (`BlockNoteCard`) and in the source inspector | When the selected block has a project note, the card shows the note text above the stats. A stale note adds "Code changed since this note was written." Its Edit button opens the notes dialog (NOTES-09). In the web build, notes come from page memory and never report stale. | Browser |
| INSP-08 | Add or Edit note button | Side panel in `App` (`DetailsPanel`) | Reads "Add note" or "Edit note" depending on whether the block already has one. The tooltip names the block, the N shortcut, and the on-disk location. Feature groups and web builds with notes turned off show no button. See NOTES-02. | Browser |

## Source inspector and code editor

The source inspector replaces the side panel when a block opens. The fixture source provides no editor, so in the web build clicking a block only selects and drills (MAP-07) and none of these rows render. Every row here is desktop-only.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| EDIT-01 | Open source inspector | Block activation in `App` | Clicking a block with source opens the inspector beside the map, titled with the block label. Folder rows never open it. Without an editor source the inspector never opens. | Desktop-only |
| EDIT-02 | Inspector header and close | `SourceInspectorPanel` header | The kicker reads "READ-ONLY SOURCE", or the commit label while a diff shows (DIFF-10). Under the title, the file path appears once loaded. The X button closes the inspector and clears any diff. | Desktop-only |
| EDIT-03 | Loading source state | `SourceInspectorPanel` body | While the file reads, the body shows a spinner and "Loading source…". The lazily loaded editor first shows "Loading code inspector…". | Desktop-only |
| EDIT-04 | Source error state | `SourceInspectorPanel` body | A failed read shows the error as an alert in place of the code. | Desktop-only |
| EDIT-05 | Read-only code view | `SourceCodeEditor` (Monaco) | Shows the file with line numbers, syntax highlighting for its language, and the theme's editor colours. The view is read-only: typing does not change it, the minimap and folding stay off, and it scrolls to the block's line and column and centres them. The aria label names it read-only with the path. | Desktop-only |
| EDIT-06 | Position footer | `SourceInspectorPanel` footer | Reads "LINE n · COLUMN n" for the block's position in the file. It only appears once the file has loaded. | Desktop-only |
| EDIT-07 | Open in editor button | `SourceInspectorPanel` | Launches the file in another editor (see SET-09 and SET-10 for the command). It stays disabled until the file loads and reads "Opening editor…" during launch. | Desktop-only |
| EDIT-08 | Open-in-editor failure | `SourceInspectorPanel` | A failed launch shows the error as an alert above the code and re-enables the button. | Desktop-only |
| EDIT-09 | Word wrap from the line menu | Line context menu in the source view (NOTES-08) | Toggles wrapping for the source view. The menu item reads "Turn word wrap on" or "Turn word wrap off" to match the current state and shows the configured shortcut. The choice saves on this device and starts off. | Desktop-only |
| EDIT-10 | Word wrap shortcut | `SourceCodeEditor` key command | Pressing the configured shortcut (Alt+Z by default) while the source view has focus toggles wrapping. The Settings dialog can record a different chord or turn it off (SET-05). The binding applies only inside the editor. | Desktop-only |

## Commit diff

The commit picker lights up the blocks one commit, or a range of commits, changed. Git history comes only from the desktop source, and a build can omit it entirely, so every row here is desktop-only. Turning the feature off at build time removes the history source and the picker with it.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| DIFF-01 | Through commit selector | Map toolbar in `App`, shown when history exists and commits were found | Lists recent commits as "short-id summary" under a "Through" label, starting from "No commit". Picking one loads everything that commit changed. Clearing it also clears the Since choice (DIFF-02). No history or no commits hides the whole picker. | Desktop-only |
| DIFF-02 | Since commit selector | Map toolbar in `App`, shown after a Through pick | Lists the commits before the Through commit under a "Since" label. "This commit only" diffs the single commit; picking a commit diffs everything after it through the Through commit. If the picked commit leaves the list, the choice resets to "This commit only". Changing either selector resets the change list to collapsed, "Only changed" off, and focus at the first entry. | Desktop-only |
| DIFF-03 | Reading commit state | Banner under the map toolbar in `App` | While the diff loads, the banner reads "Reading commit…". | Desktop-only |
| DIFF-04 | Commit error state | Banner under the map toolbar in `App` | A failed read shows the error in the banner with a Clear button that clears both commit selectors. | Desktop-only |
| DIFF-05 | Diff summary banner | `CommitDiffSummary` under the map toolbar | Names the commit, or "base…through" for a range, then counts changed blocks, changed connections when any, and files outside the map when any. Changed blocks on the map and in the tree gain "+n −n" badges (MAP-07, TREE-09), ancestors of a changed block show the rolled-up count, and unchanged blocks dim. Connection edges restyle as added, changed, or removed. | Desktop-only |
| DIFF-06 | Only changed toggle | `CommitDiffSummary` banner | When on, the map draws only changed blocks and the file tree keeps only branches containing one (TREE-13). When off, the full map shows with changed blocks lit. It starts off for each new commit choice. | Desktop-only |
| DIFF-07 | Prev / Next navigation | `CommitDiffSummary` banner | Steps through the change list one entry at a time, wrapping at both ends. The banner shows the position as "n / total". Stepping selects the entry's block, opens its inspector, and centres it on the map; an entry for a file outside the map opens that file's diff instead (DIFF-11). The buttons disable when the list is empty. | Desktop-only |
| DIFF-08 | Change navigation keys | Global key handler in `App` | "]" steps to the next change and "[" to the previous, wrapping at the ends. The keys do nothing while typing in an input, textarea, select, or editable element, and only while a commit diff is ready. The banner hints "[ ]". | Desktop-only |
| DIFF-09 | Change list | Expanded `CommitDiffSummary` banner | The expand button toggles a legend (added and removed lines, dimmed meaning, connection colours) and a list of every directly changed block and every changed file outside the map, sorted by label, each with "+n −n" counts or "binary". Clicking an entry navigates like DIFF-07 and marks it current. | Desktop-only |
| DIFF-10 | Block diff view | `SourceInspectorPanel` with `SourceDiffEditor` | While a commit is active, inspecting a block it changed shows a read-only side-by-side diff of that block's file instead of the current source, falling back to inline layout under 520px. The header kicker names the commit. The view reveals the changed line once the diff computes. Loading and failure states read "Loading commit diff…" / the error, with "Loading diff viewer…" while the editor loads. | Desktop-only |
| DIFF-11 | Outside-map file diff | `SourceInspectorPanel` with `SourceDiffEditor` | Navigating to a changed file that has no block in the map (DIFF-09) titles the inspector with the file path and shows that file's diff the same way as DIFF-10. | Desktop-only |

## Project notes

Notes attach free text to a block. The dialog and menus render in both builds: the desktop app reads and writes `.lightwell/notes.json` in the workspace, while the web build keeps notes in page memory for the session. A build can turn notes off, which removes the toolbar button, menu items, and dialog wiring in both builds.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| NOTES-01 | Notes toolbar button | Map toolbar in `App` | Opens the notes dialog for the inspected block, or the selected block when no inspector is open. Its label reads "Notes" with a saved-note count badge when any exist. The tooltip mentions the N shortcut and right-click. The button disappears when notes are turned off at build time. | Browser |
| NOTES-02 | Add / Edit note buttons | `DetailsPanel` (INSP-08) and `SourceInspectorPanel` header area | Opens the notes dialog for that block. The inspector copy shows an "N" hint and a tooltip about right-clicking a line. In the web build the inspector copy never renders (EDIT-01). | Browser |
| NOTES-03 | Add-note shortcut | Global key handler in `App` | A plain "N" press (no Ctrl, Cmd, or Alt) opens the notes dialog for the inspected or selected block. It does nothing while typing in an input, textarea, select, or editable element, while a dialog or the context menu is open, for feature groups, or when notes are unavailable. | Browser |
| NOTES-04 | Block context menu | `NoteContextMenu`, opened from the map, inspector rows, and details rows | Right-clicking a block, or pressing the ContextMenu key or Shift+F10 on a focused node or row, opens a small menu titled with the block name at the pointer or row. It closes on an outside mousedown, window blur or resize, Escape (which returns focus to the opener), or after choosing an item. Arrow keys, Home, and End move between items; Tab closes it. The next rows list its items. | Browser |
| NOTES-05 | Add / Edit / Delete note items | `NoteContextMenu` (`noteMenuItems`) | With notes available, the menu offers "Add note" (with the N hint) or "Edit note" plus a danger-styled "Delete note". Add opens the dialog; with a source line attached it pre-fills "Line n: " (NOTES-08). Delete asks "Delete the note on …?" first; cancelling keeps the note, and a failed delete reports in NOTES-13. Without notes available, none of these items appear. | Browser |
| NOTES-06 | Open source item | `NoteContextMenu` (`noteMenuItems`) | "Open source" opens the block's source inspector (EDIT-01). It appears only when an editor source exists and the menu did not come from a source line, so it never appears in the web build. | Desktop-only |
| NOTES-07 | Copy path item | `NoteContextMenu` (`noteMenuItems`) | Copies the block's source path to the clipboard. From a source line it copies "path:line". A failed copy reports "Could not copy the path." (NOTES-13). Blocks with no source path show no item. | Browser |
| NOTES-08 | Source line menu and word wrap item | `SourceCodeEditor` context handling into `NoteContextMenu` | Right-clicking a source line, or pressing Shift+F10 or the ContextMenu key in the editor, opens the menu titled "block · line n" for that line. It adds the word-wrap item (EDIT-09) and drops "Open source". The browser's own menu is suppressed. The code view never renders in the web build. | Desktop-only |
| NOTES-09 | Notes dialog | `ProjectNotesDialog` | A modal dialog titled "Project notes" with the saved count and "kept with this workspace". The left list holds every note; the right side edits the chosen one. It opens focused on the text area, traps Tab inside, and closes on Escape or the X button. Opening it from the node badge (MAP-09), a menu, or a button targets that block. | Browser |
| NOTES-10 | Note list and selection | `ProjectNotesDialog` list panel | Each row shows the block label (or its ID when the block is gone), a one-line preview, and a badge: "Current", "Source changed", or "Block removed". Current notes sort before stale ones, then by block ID. Clicking a row loads it into the editor; with unsaved edits, a "Discard unsaved note changes?" prompt guards the switch. | Browser |
| NOTES-11 | Note editor and save | `ProjectNotesDialog` editor | The header names the target block ("NEW NOTE FOR" or "NOTE FOR"), its source path, and a stale warning when the code moved since the note was written. Save stays disabled until the text is non-blank. Saving writes the note and reports "Saved in .lightwell/notes.json"; Ctrl or Cmd+Enter saves from the keyboard. Failures show as an alert and keep the text. In the web build the same steps write to page memory and still show the on-disk message. | Browser |
| NOTES-12 | New note and empty states | `ProjectNotesDialog` list panel | "New" starts a note for the current block, disabled when no block is current or notes failed to load. With no notes, the list reads "No notes yet." and either asks the user to select a block first or offers "Add note to …", which focuses the editor. An unreadable notes file shows "Notes could not be read from this workspace." in the list and the error above a disabled editor. | Browser |
| NOTES-13 | Note action errors | Banner in `App` and dialog feedback in `ProjectNotesDialog` | Delete and copy failures from menus surface in a dismissible-style alert banner under the shell ("Could not delete this note." / "Could not copy the path."). Save and remove failures show inside the dialog. A successful remove reports "Note removed" and returns the editor to the current block. | Browser |
| NOTES-14 | Show on map | `ProjectNotesDialog` editor header | "Show on map" closes the dialog, selects the note's block, restores its scope path, and centres it on the map. It appears only when the note's block still exists in the map. | Browser |
| NOTES-15 | On-disk notes and staleness | Desktop source into `App` and `ProjectNotesDialog` | The desktop app stores notes in `.lightwell/notes.json`, keyed by block ID with the source fingerprint from when the note was written. A note whose block changed or vanished reads stale everywhere it appears (INSP-07, NOTES-10) and stays stored until removed. The web build's memory notes use a fixed fingerprint and never go stale, and they vanish on reload. | Desktop-only |

## Settings

The Settings dialog opens from APP-06. Appearance, text size, and source-view choices apply immediately and save on this device; only the editor command needs the Save button, and only in the desktop app.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| SET-01 | Theme selector | `EditorSettingsPanel`, Appearance | "Follow system", "Dark", "Light", or "Blueprint". The choice applies at once to the shell and editors and saves on this device. New installs default to blueprint (APP-13). | Browser |
| SET-02 | UI text size | `EditorSettingsPanel`, Text size | "−" and "+" step the interface scale by 10% between 80% and 160%; Reset returns to 100% and disables at the default. The end buttons disable at the limits. Applies across the app at once and saves on this device. | Browser |
| SET-03 | Source code size | `EditorSettingsPanel`, Text size | Steps the code size by 1px between 11px and 22px; Reset returns to 13px. It drives the Monaco font size and line height, so in the web build the control and its saved value work but no code view is on screen to show the change. | Browser |
| SET-04 | Tree and map label size | `EditorSettingsPanel`, Text size | Steps the label scale by 10% between 80% and 160%; Reset returns to 100%. It rescales map node text, connection labels, and file-tree rows, then re-lays out the graph. Applies at once and saves on this device. | Browser |
| SET-05 | Word wrap shortcut recorder | `EditorSettingsPanel`, Source view | Clicking the shortcut button records the next chord: Ctrl, Alt, or Meta plus a letter or digit, or an F-key alone. Escape cancels, Backspace or Delete turns the shortcut off, and an unsupported press shows "Use Ctrl, Alt, or Meta with a letter or number, or an F-key." Reset restores Alt+Z and disables at the default; "Turn off" clears it and disables when already off. The value saves on this device. See EDIT-10. | Browser |
| SET-06 | Automatic update check toggle | `EditorSettingsPanel`, Updates | A checkbox, on by default, saved on this device. In the web build the help text notes that update checks run in the desktop app. Turning it off stops the launch-time check on desktop. | Browser |
| SET-07 | Check now button | `EditorSettingsPanel`, Updates | Runs an update check and reports beside the button: "Checking…", "Lightwell is up to date.", "Version … is available.", or the failure. In the web build the button is disabled. A found update also opens the update prompt (SET-12). | Desktop-only |
| SET-08 | Editor preset selector | `EditorSettingsPanel`, Editor section, desktop builds only | "Choose an example…" fills the command template from the picked preset without saving. Picking a preset or editing the template clears any stale save status. The whole Editor section, including this control, is absent in the web build. | Desktop-only |
| SET-09 | Editor command template | `EditorSettingsPanel`, Editor section, desktop builds only | A free-text template using `{file}`, `{line}`, and `{column}`. Blank means the OS default app, falling back to the `VISUAL` then `EDITOR` environment variables. Lightwell passes arguments directly with no shell. See EDIT-07. | Desktop-only |
| SET-10 | Save editor preference | `EditorSettingsPanel` footer, desktop builds only | Saves the template (blank clears it). While saving, the button reads "Saving…" and blocks repeat clicks. Success shows "Saved" for 2 seconds; failure shows the error as an alert and keeps the text. The button disables until settings finish loading; a load failure shows its own alert in the Editor section. | Desktop-only |
| SET-11 | Settings dialog behaviour | `EditorSettingsPanel` | A modal dialog that focuses Close on open, traps Tab among its enabled controls, and closes on Escape, the X button, or Close. Theme and size changes show the same transient "Saved" note as SET-10. The About section links to the privacy policy, terms, and security page in a new tab. | Browser |
| SET-12 | Update prompt | `UpdatePrompt` over the shell, desktop builds only | When a check finds an update, a modal shows "Update available", the version, and the release notes (or "No release notes for this version."). "Not now" dismisses it until the next check finds one. Integrated builds offer "Install update" ("Installing…" during install, then the app relaunches; a failure reports in SET-07's status instead). Manual builds explain the package cannot replace itself and link "Download update" to the latest release. The prompt never appears in the web build. | Desktop-only |

## Splitters

Both splitters share one component. Sizes save per workspace in `localStorage`, keyed by project and splitter, so each workspace remembers its own layout.

| ID | Control or state | Where it lives | Expected behavior | Coverage |
| --- | --- | --- | --- | --- |
| SPL-01 | Map / source splitter | `Splitter` (`map-source`) between the map column and the side panel in `App` | Dragging the 8px handle resizes the map against the panel. The map keeps at least 520px and the panel at least 240px; on narrower windows the minimums split the space evenly. The size persists on pointer release. The panel side starts at 318px. | Browser |
| SPL-02 | Map / features splitter | `Splitter` (`map-features`) between the graph and the feature footer in `App` | Dragging resizes the graph against the feature strip. The graph keeps at least 240px and the strip at least 140px. The strip starts at 197px. The size persists on pointer release. | Browser |
| SPL-03 | Splitter keyboard resize | Splitter handle in `Splitter` | With the handle focused, Left/Right (horizontal splitter) or Up/Down (vertical) move it 24px per press, 6px with Shift. Every press persists at once. The handle exposes its label, orientation, and current size in pixels to assistive tech. Non-left mouse buttons never start a drag. | Browser |
| SPL-04 | Splitter reset | Splitter handle in `Splitter` | Double-clicking the handle restores the default trailing size (SPL-01, SPL-02) and persists it. | Browser |
| SPL-05 | Restored splitter sizes | `Splitter` on load and on workspace switch | Each workspace reopens with its last saved sizes for both splitters. A missing or unreadable value falls back to the defaults. Storage failures still apply the size for the session. | Browser |

## Desktop-only (not covered by the web suite)

These IDs need Tauri and stay out of the Playwright suite. Each entry gives the reason.

| ID | Why it needs the desktop app |
| --- | --- |
| APP-02 | Folder dialog and workspace extraction run through Tauri commands. |
| APP-11 | The fixture source always returns two maps, so the empty state needs a desktop source with no recent workspaces. |
| APP-12 | Every message that fills this banner comes from desktop-only operations. |
| APP-14 | Live refresh needs the desktop file watcher. |
| TREE-13 | Row filtering needs commit data from git history. |
| EDIT-01 – EDIT-10 | Source reads, the Monaco inspector, and opening another editor all run through the desktop editor source; the fixture source has none. |
| DIFF-01 – DIFF-11 | Commit lists, changes, and file diffs run through the desktop history source; the fixture source has none. |
| NOTES-06 | "Open source" needs the desktop editor source. |
| NOTES-08 | The line menu needs the source view, which needs the desktop editor source. |
| NOTES-15 | Writing `.lightwell/notes.json` and fingerprint staleness need the desktop notes store. |
| SET-07 | Update checks run through the desktop updater. |
| SET-08 – SET-10 | Editor presets, the command template, and its save run through the desktop editor source. |
| SET-12 | The update prompt only follows a desktop update check. |

### Proposed follow-up (not started)

Add a separate desktop suite that drives the packaged app through its automation driver against a throwaway Rust workspace. It would cover the rows above in table order: opening a workspace, inspecting and opening source, the commit picker and diff views, notes written to disk and their staleness after an edit, and the editor-preference save. Update install itself can stop at the prompt, since installing replaces the app under test. Nothing in this proposal is built yet.

## Coverage

Stage 2 will add a table here mapping each Playwright test title to the feature IDs it covers. No tests exist yet, so this section stays empty on purpose.
