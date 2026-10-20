import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Settings2, X } from "lucide-react";
import type { EditorSettings, MapEditorSource } from "./map-source.js";
import type { TreeSelectAction } from "./tree-select.js";
import { isThemePreference, type ResolvedTheme, type ThemePreference } from "./theme.js";
import {
  CODE_SIZE_DEFAULT,
  CODE_SIZE_MAX,
  CODE_SIZE_MIN,
  LABEL_SCALE_DEFAULT,
  LABEL_SCALE_MAX,
  LABEL_SCALE_MIN,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  clampTextSize,
  formatTextSize,
  stepTextSize,
  type TextSize,
  type TextSizeAxis,
} from "./type-scale.js";
import { DEFAULT_WORD_WRAP_SHORTCUT, shortcutFromKeyEvent } from "./source-view-preferences.js";
import type { UpdateDelivery } from "./app-updates.js";

type PanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly presets: Awaited<ReturnType<MapEditorSource["listPresets"]>> }
  | { readonly kind: "error"; readonly message: string };

function errorMessage(error: unknown, fallback = "Could not load editor settings."): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
}

/** How long the "Saved" confirmation stays visible before it hides itself. */
export const SAVED_STATUS_MS = 2000;

export type SaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "error"; readonly message: string };

export type SaveOutcome =
  | { readonly status: { readonly kind: "saved" }; readonly settings: EditorSettings }
  | { readonly status: { readonly kind: "error"; readonly message: string } };

/** Persists the editor preference and maps the result to a UI save status. */
export async function saveEditorPreference(
  editor: Pick<MapEditorSource, "saveSettings">,
  template: string,
): Promise<SaveOutcome> {
  try {
    const settings = await editor.saveSettings({ commandTemplate: template.trim() || null });
    return { status: { kind: "saved" }, settings };
  } catch (error: unknown) {
    return { status: { kind: "error", message: errorMessage(error, "Could not save editor preference.") } };
  }
}

/** Inline save feedback: a polite live region for "Saved", an alert for failures. */
export function SaveStatusMessage({ status }: { readonly status: SaveStatus }) {
  return (
    <div className="settings-footer-status">
      <div className="settings-save-live" role="status" aria-live="polite" aria-atomic="true">
        {status.kind === "saved" && <span className="settings-saved"><Check size={14} />Saved</span>}
      </div>
      {status.kind === "error" && (
        <div className="settings-error settings-save-error" role="alert"><CircleAlert size={14} />{status.message}</div>
      )}
    </div>
  );
}

export function SaveEditorButton({ status, disabled, onSave }: {
  readonly status: SaveStatus;
  readonly disabled: boolean;
  readonly onSave: () => void;
}) {
  const saving = status.kind === "saving";
  return (
    <button
      className="settings-save-button"
      type="button"
      onClick={onSave}
      disabled={disabled || saving}
      aria-busy={saving}
    >
      {saving ? <LoaderCircle size={14} className="settings-save-spinner" aria-hidden="true" /> : <Check size={14} />}
      {saving ? "Saving…" : "Save editor preference"}
    </button>
  );
}

/** Records a key combination: click, press the keys; Escape cancels and Backspace turns it off. */
export function ShortcutRecorder({
  id,
  label,
  shortcut,
  defaultShortcut,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly defaultShortcut: string;
  readonly onChange: (shortcut: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  const stop = () => { setRecording(false); setHint(""); };
  return (
    <>
      <label className="settings-field-label" htmlFor={id}>{label}</label>
      <div className="settings-shortcut-row">
        <button
          id={id}
          type="button"
          className={`settings-shortcut${recording ? " recording" : ""}`}
          aria-describedby={hint.length > 0 ? `${id}-hint` : undefined}
          onClick={() => { setRecording(true); setHint(""); }}
          onBlur={stop}
          onKeyDown={(event) => {
            if (!recording) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") { stop(); return; }
            if (event.key === "Backspace" || event.key === "Delete") { onChange(""); stop(); return; }
            if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
            const recorded = shortcutFromKeyEvent(event);
            if (recorded === null) {
              setHint("Use Ctrl, Alt, or Meta with a letter or number, or an F-key.");
              return;
            }
            onChange(recorded);
            stop();
          }}
        >
          {recording ? "Press keys…" : shortcut.length > 0 ? <kbd>{shortcut}</kbd> : "Off"}
        </button>
        <button type="button" className="settings-shortcut-action" disabled={shortcut === defaultShortcut} onClick={() => onChange(defaultShortcut)}>Reset</button>
        <button type="button" className="settings-shortcut-action" disabled={shortcut.length === 0} onClick={() => onChange("")}>Turn off</button>
      </div>
      {hint.length > 0 && <p className="settings-error" id={`${id}-hint`} role="alert">{hint}</p>}
    </>
  );
}

function TextSizeControl({
  label,
  axis,
  value,
  onChange,
}: {
  readonly label: string;
  readonly axis: TextSizeAxis;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  const current = clampTextSize(value, axis);
  const minimum = axis === "code" ? CODE_SIZE_MIN : axis === "ui" ? UI_SCALE_MIN : LABEL_SCALE_MIN;
  const maximum = axis === "code" ? CODE_SIZE_MAX : axis === "ui" ? UI_SCALE_MAX : LABEL_SCALE_MAX;
  const fallback = axis === "code" ? CODE_SIZE_DEFAULT : axis === "ui" ? UI_SCALE_DEFAULT : LABEL_SCALE_DEFAULT;
  return (
    <div className="settings-type-size" role="group" aria-label={label}>
      <span className="settings-field-label">{label}</span>
      <div className="settings-type-size-row">
        <button type="button" aria-label={`Decrease ${label}`} disabled={current <= minimum} onClick={() => onChange(stepTextSize(current, axis, -1))}>−</button>
        <span className="settings-type-size-value">{formatTextSize(current, axis)}</span>
        <button type="button" aria-label={`Increase ${label}`} disabled={current >= maximum} onClick={() => onChange(stepTextSize(current, axis, 1))}>+</button>
        <button type="button" className="settings-shortcut-action" aria-label={`Reset ${label}`} disabled={current === fallback} onClick={() => onChange(fallback)}>Reset</button>
      </div>
    </div>
  );
}

export default function EditorSettingsPanel({
  editor,
  themePreference,
  theme,
  onThemeChange,
  wordWrapShortcut,
  onWordWrapShortcutChange,
  updateDelivery,
  autoUpdateCheck,
  onAutoUpdateCheckChange,
  updateStatus,
  onCheckForUpdate,
  onClose,
  textSize,
  onTextSizeChange,
  treeSelectAction,
  onTreeSelectActionChange,
}: {
  readonly editor?: MapEditorSource;
  readonly themePreference: ThemePreference;
  readonly theme: ResolvedTheme;
  readonly onThemeChange: (preference: ThemePreference) => void;
  readonly textSize: TextSize;
  readonly onTextSizeChange: (size: TextSize) => void;
  /** What selecting a file or symbol row in the Files view does (SET-13). */
  readonly treeSelectAction: TreeSelectAction;
  readonly onTreeSelectActionChange: (action: TreeSelectAction) => void;
  /** Source view word wrap shortcut, "" when turned off. */
  readonly wordWrapShortcut: string;
  readonly onWordWrapShortcutChange: (shortcut: string) => void;
  readonly updateDelivery: UpdateDelivery;
  readonly autoUpdateCheck: boolean;
  readonly onAutoUpdateCheckChange: (enabled: boolean) => void;
  readonly updateStatus: string;
  readonly onCheckForUpdate: () => void;
  readonly onClose: () => void;
}) {
  const [panelState, setPanelState] = useState<PanelState>({ kind: "loading" });
  const [template, setTemplate] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (editor === undefined) {
      setPanelState({ kind: "ready", presets: [] });
      return;
    }
    let cancelled = false;
    void Promise.all([editor.loadSettings(), editor.listPresets()])
      .then(([settings, presets]) => {
        if (cancelled) return;
        setTemplate(settings.commandTemplate ?? "");
        setPanelState({ kind: "ready", presets });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPanelState({ kind: "error", message: errorMessage(error) });
      });
    return () => { cancelled = true; };
  }, [editor]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
      );
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (saveStatus.kind !== "saved") return;
    const timer = window.setTimeout(() => setSaveStatus({ kind: "idle" }), SAVED_STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  const clearSaveStatus = () => setSaveStatus((current) => (current.kind === "saving" ? current : { kind: "idle" }));

  const save = async () => {
    if (editor === undefined) return;
    setSaveStatus({ kind: "saving" });
    const outcome = await saveEditorPreference(editor, template);
    if ("settings" in outcome) setTemplate(outcome.settings.commandTemplate ?? "");
    setSaveStatus(outcome.status);
  };

  return (
    <div className="settings-backdrop">
      <section
        ref={dialogRef}
        className="editor-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-settings-title"
      >
        <header className="settings-panel-header">
          <div className="settings-panel-title">
            <span className="settings-panel-icon"><Settings2 size={16} /></span>
            <div>
              <h2 id="editor-settings-title">Settings</h2>
              <p>Choose how Lightwell looks, sizes text, opens source files, and checks for updates</p>
            </div>
          </div>
          <button
            className="icon-button"
            ref={closeButtonRef}
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          ><X size={16} /></button>
        </header>

        <div className="settings-panel-body">
          <h3 className="settings-section-title">Appearance</h3>
          <label className="settings-field-label" htmlFor="lightwell-theme">THEME</label>
          <select
            id="lightwell-theme"
            className="settings-select"
            value={themePreference}
            onChange={(event) => {
              const preference = event.currentTarget.value;
              if (isThemePreference(preference)) {
                onThemeChange(preference);
                setSaveStatus((current) => (current.kind === "saving" ? current : { kind: "saved" }));
              }
            }}
          >
            <option value="system">Follow system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="blueprint">Blueprint</option>
          </select>
          <p className="settings-help">Theme changes apply immediately and stay saved on this device.</p>

          <h3 className="settings-section-title settings-editor-section">Text size</h3>
          <TextSizeControl label="UI text" axis="ui" value={textSize.ui} onChange={(ui) => onTextSizeChange({ ...textSize, ui })} />
          <TextSizeControl label="Source code" axis="code" value={textSize.code} onChange={(code) => onTextSizeChange({ ...textSize, code })} />
          <TextSizeControl label="Tree and map labels" axis="labels" value={textSize.labels} onChange={(labels) => onTextSizeChange({ ...textSize, labels })} />
          <p className="settings-help">Each size applies across that part of the app and stays saved on this device.</p>

          <h3 className="settings-section-title settings-editor-section">Source view</h3>
          <ShortcutRecorder
            id="lightwell-word-wrap-shortcut"
            label="WORD WRAP SHORTCUT"
            shortcut={wordWrapShortcut}
            defaultShortcut={DEFAULT_WORD_WRAP_SHORTCUT}
            onChange={onWordWrapShortcutChange}
          />
          <p className="settings-help">Toggles word wrap while the source view has focus. Change it if another program already uses {DEFAULT_WORD_WRAP_SHORTCUT}.</p>

          <h3 className="settings-section-title settings-editor-section">File tree</h3>
          <label className="settings-field-label" htmlFor="lightwell-tree-select-action">SELECTING A FILE OR SYMBOL</label>
          <select
            id="lightwell-tree-select-action"
            className="settings-select"
            value={treeSelectAction}
            onChange={(event) => {
              const action = event.currentTarget.value;
              if (action === "open-source" || action === "show-details") {
                onTreeSelectActionChange(action);
                setSaveStatus((current) => (current.kind === "saving" ? current : { kind: "saved" }));
              }
            }}
          >
            <option value="open-source">Open its source</option>
            <option value="show-details">Show its details first</option>
          </select>
          <p className="settings-help">Folders always show their details. The choice applies at once and stays saved on this device.</p>

          <h3 className="settings-section-title settings-editor-section">Updates</h3>
          <label className="settings-check" htmlFor="lightwell-auto-update">
            <input
              id="lightwell-auto-update"
              type="checkbox"
              checked={autoUpdateCheck}
              onChange={(event) => onAutoUpdateCheckChange(event.currentTarget.checked)}
            />
            Automatically check for updates
          </label>
          <p className="settings-help">
            {updateDelivery === "unavailable"
              ? "Update checks run in the desktop app. This choice is saved on this device."
              : updateDelivery === "manual"
                ? "This package cannot replace itself. When an update is available, Lightwell shows the release notes and a download link."
                : "Lightwell shows the release notes before it installs an update."}
          </p>
          <div className="settings-update-row">
            <button className="settings-shortcut-action" type="button" onClick={onCheckForUpdate} disabled={updateDelivery === "unavailable"}>
              Check now
            </button>
            {updateStatus.length > 0 && <span className="settings-help">{updateStatus}</span>}
          </div>

          {editor !== undefined && <>
          <h3 className="settings-section-title settings-editor-section">Editor</h3>
          <p className="settings-explainer">
            The inspector is read-only. Use <strong>Open in editor</strong> to make changes in your editor.
          </p>
          <label className="settings-field-label" htmlFor="editor-preset">START WITH A PRESET</label>
          <select
            id="editor-preset"
            className="settings-select"
            value={selectedPreset}
            disabled={panelState.kind !== "ready"}
            onChange={(event) => {
              const preset = panelState.kind === "ready"
                ? panelState.presets.find((item) => item.name === event.currentTarget.value)
                : undefined;
              setSelectedPreset(preset?.name ?? "");
              if (preset !== undefined) setTemplate(preset.template);
              clearSaveStatus();
            }}
          >
            <option value="">Choose an example…</option>
            {panelState.kind === "ready" && panelState.presets.map((preset) => (
              <option key={preset.name} value={preset.name}>{preset.name}</option>
            ))}
          </select>

          <label className="settings-field-label" htmlFor="editor-command">EDITOR COMMAND TEMPLATE</label>
          <textarea
            id="editor-command"
            className="settings-command-input"
            value={template}
            placeholder="Leave blank to use the OS default app"
            spellCheck={false}
            disabled={panelState.kind !== "ready"}
            onChange={(event) => {
              setTemplate(event.currentTarget.value);
              setSelectedPreset("");
              clearSaveStatus();
            }}
          />
          <p className="settings-help">
            Use <code>{"{file}"}</code>, <code>{"{line}"}</code>, and <code>{"{column}"}</code> where needed. Blank uses the OS default app; if it cannot open the file, Lightwell tries <code>VISUAL</code> and then <code>EDITOR</code>.
          </p>
          <p className="settings-help">
            Presets are examples. You can enter any editor command. Lightwell passes arguments directly without shell evaluation.
          </p>

          {editor !== undefined && panelState.kind === "loading" && <div className="settings-status">Loading editor settings…</div>}
          {editor !== undefined && panelState.kind === "error" && <div className="settings-error" role="alert"><CircleAlert size={14} />{panelState.message}</div>}
          </>}

          <h3 className="settings-section-title">About Lightwell</h3>
          <p className="settings-help">
            Lightwell keeps maps and notes on your machine. Read how we handle site traffic and how to report security issues:
          </p>
          <p className="settings-legal-links">
            <a href="https://lightwellcli.com/privacy.html" target="_blank" rel="noopener noreferrer">Privacy policy</a>
            <span aria-hidden="true"> · </span>
            <a href="https://lightwellcli.com/terms.html" target="_blank" rel="noopener noreferrer">Terms of use</a>
            <span aria-hidden="true"> · </span>
            <a href="https://github.com/moonbase2090/lightwell/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer">Security</a>
          </p>
        </div>

        <footer className="settings-panel-footer">
          <SaveStatusMessage status={saveStatus} />
          <button className="settings-cancel-button" type="button" onClick={onClose}>Close</button>
          {editor !== undefined && (
            <SaveEditorButton
              status={saveStatus}
              disabled={panelState.kind !== "ready"}
              onSave={() => { void save(); }}
            />
          )}
        </footer>
      </section>
    </div>
  );
}
