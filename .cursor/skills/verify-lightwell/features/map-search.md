# Map search

A developer filters visible map blocks with the search field labeled **Search map**.

## Sub-features

- `search-focus` — focus the search input from the toolbar.
- `search-filter` — typing narrows visible blocks.

## How to get to it (user POV)

- Load a map in the viewer (browser preview or desktop).
- Activate the search control with label **Search map** (`aria-label` on the input).

## Driving it with browser automation

Preconditions:

- A map is loaded (browser preview with Prismattyc is enough).
- Automation can reach the page (Playwright, manual check, or Tauri capture scripts in `scripts/ci/capture-*.sh` on Linux CI).

- **Manual proof:** type a substring of a known crate name from `maps/prismattyc.facts.json`; results list (`role="listbox"`, `aria-label="Map search results"`) should list matching blocks.
- **CI reference:** `scripts/ci/capture-open-workspace.sh` exercises the desktop map window on Linux with Xvfb (not the browser preview).

## Gotchas

- Search operates on the current map; switch maps before searching if testing Scorecard-specific strings.
- Empty search should restore the full graph; clearing search is part of a full UI pass, not required for minimal CLI/preview proof.
