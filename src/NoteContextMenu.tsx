import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUpRight, Copy, FilePen, FilePlus2, Trash2, WrapText } from "lucide-react";

export type NoteMenuAction = "add-note" | "edit-note" | "delete-note" | "open" | "copy-path" | "toggle-word-wrap";

export interface NoteMenuItem {
  readonly action: NoteMenuAction;
  readonly label: string;
  readonly shortcut?: string;
  readonly danger?: boolean;
}

export interface NoteMenuTarget {
  readonly blockId: string;
  readonly x: number;
  readonly y: number;
  readonly line?: number;
}

export const addNoteShortcut = "N";

/** The menu offered for a block. Note actions appear only when notes can be saved. */
export function noteMenuItems(options: {
  readonly notesAvailable: boolean;
  readonly hasNote: boolean;
  readonly canOpen: boolean;
  readonly sourcePath: string | null;
  /** Current word wrap in the source view; the toggle is offered only there. */
  readonly wordWrap?: boolean;
  /** Configured toggle shortcut shown beside the item; "" for none. */
  readonly wordWrapShortcut?: string;
}): NoteMenuItem[] {
  const items: NoteMenuItem[] = [];
  if (options.notesAvailable) {
    if (options.hasNote) {
      items.push({ action: "edit-note", label: "Edit note", shortcut: addNoteShortcut });
      items.push({ action: "delete-note", label: "Delete note", danger: true });
    } else {
      items.push({ action: "add-note", label: "Add note", shortcut: addNoteShortcut });
    }
  }
  if (options.canOpen) items.push({ action: "open", label: "Open source" });
  if (options.sourcePath !== null) items.push({ action: "copy-path", label: "Copy path" });
  if (options.wordWrap !== undefined) {
    const label = options.wordWrap ? "Turn word wrap off" : "Turn word wrap on";
    const shortcut = options.wordWrapShortcut ?? "";
    items.push(shortcut === "" ? { action: "toggle-word-wrap", label } : { action: "toggle-word-wrap", label, shortcut });
  }
  return items;
}

/** True for the keys that open a context menu from the keyboard. */
export function isContextMenuKey(event: { readonly key: string; readonly shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/** True when a plain key press is the add-note shortcut and focus is not in a text field. */
export function isAddNoteShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly targetTag: string;
  readonly targetEditable: boolean;
}): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.targetEditable) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(event.targetTag)) return false;
  return event.key.toLowerCase() === addNoteShortcut.toLowerCase();
}

const icons = {
  "add-note": FilePlus2,
  "edit-note": FilePen,
  "delete-note": Trash2,
  open: ArrowUpRight,
  "copy-path": Copy,
  "toggle-word-wrap": WrapText,
} satisfies Record<NoteMenuAction, unknown>;

export default function NoteContextMenu({
  x,
  y,
  title,
  items,
  onChoose,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly items: readonly NoteMenuItem[];
  readonly onChoose: (action: NoteMenuAction) => void;
  readonly onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const closeOnOutside = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        opener?.focus();
      }
    };
    window.addEventListener("mousedown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === "ArrowDown" ? index + 1
      : event.key === "ArrowUp" ? index - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : null;
    if (next === null) {
      if (event.key === "Tab") { event.preventDefault(); onClose(); }
      return;
    }
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  const left = typeof window === "undefined" ? x : Math.max(4, Math.min(x, window.innerWidth - 220));
  const top = typeof window === "undefined" ? y : Math.max(4, Math.min(y, window.innerHeight - (items.length * 34 + 44)));
  return (
    <div
      ref={menuRef}
      className="note-context-menu"
      role="menu"
      aria-label={`Actions for ${title}`}
      style={{ left, top }}
      onKeyDown={moveFocus}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="note-context-menu-title" aria-hidden="true">{title}</div>
      {items.map((item) => {
        const Icon = icons[item.action];
        return (
          <button
            key={item.action}
            className={`note-context-menu-item${item.danger === true ? " danger" : ""}`}
            role="menuitem"
            type="button"
            tabIndex={-1}
            onClick={() => { onClose(); onChoose(item.action); }}
          >
            <Icon size={13} />
            <span>{item.label}</span>
            {item.shortcut !== undefined && <kbd aria-hidden="true">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
