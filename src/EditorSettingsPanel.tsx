import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Settings2, X } from "lucide-react";
import type { EditorSettings, MapEditorSource } from "./map-source.js";
import { isThemePreference, type ResolvedTheme, type ThemePreference } from "./theme.js";

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

export default function EditorSettingsPanel({
  editor,
  themePreference,
  theme,
  onThemeChange,
  onClose,
}: {
  readonly editor: MapEditorSource;
  readonly themePreference: ThemePreference;
  readonly theme: ResolvedTheme;
  readonly onThemeChange: (preference: ThemePreference) => void;
  readonly onClose: () => void;
}) {
  const [panelState, setPanelState] = useState<PanelState>({ kind: "loading" });
  const [template, setTemplate] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
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
              <p>Choose how Lightwell looks and opens source files</p>
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

          {panelState.kind === "loading" && <div className="settings-status">Loading editor settings…</div>}
          {panelState.kind === "error" && <div className="settings-error" role="alert"><CircleAlert size={14} />{panelState.message}</div>}

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
          <SaveEditorButton
            status={saveStatus}
            disabled={panelState.kind !== "ready"}
            onSave={() => { void save(); }}
          />
        </footer>
      </section>
    </div>
  );
}
