export const TREE_SELECT_ACTION_KEY = "lightwell.tree-select-action.v1";

/** What selecting a file or symbol row in the Files view does. */
export type TreeSelectAction = "open-source" | "show-details";

export interface TreeSelectStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Selecting a file or symbol opens its source until this device says otherwise. */
export const DEFAULT_TREE_SELECT_ACTION: TreeSelectAction = "open-source";

export function parseTreeSelectAction(value: string | null): TreeSelectAction {
  return value === "show-details" ? "show-details" : DEFAULT_TREE_SELECT_ACTION;
}

export function readTreeSelectAction(storage: TreeSelectStorage | null): TreeSelectAction {
  if (storage === null) return DEFAULT_TREE_SELECT_ACTION;
  try {
    return parseTreeSelectAction(storage.getItem(TREE_SELECT_ACTION_KEY));
  } catch {
    return DEFAULT_TREE_SELECT_ACTION;
  }
}

export function writeTreeSelectAction(storage: TreeSelectStorage | null, action: TreeSelectAction): void {
  if (storage === null) return;
  try {
    storage.setItem(TREE_SELECT_ACTION_KEY, action);
  } catch {
    // The choice still applies for this session.
  }
}
