import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Settings2, X } from "lucide-react";
import type { MapEditorSource } from "./map-source.js";
import { isThemePreference, type ResolvedTheme, type ThemePreference } from "./theme.js";

type PanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly presets: Awaited<ReturnType<MapEditorSource["listPresets"]>> }
  | { readonly kind: "error"; readonly message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "Could not load editor settings.";
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
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

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
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const settings = await editor.saveSettings({ commandTemplate: template.trim() || null });
      setTemplate(settings.commandTemplate ?? "");
      setSaveMessage("Editor preference saved.");
    } catch (error: unknown) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop">
      <section
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
              if (isThemePreference(preference)) onThemeChange(preference);
            }}
          >
            <option value="system">Follow system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="blueprint">Blueprint</option>
          </select>
          <p className="settings-help">Theme changes apply immediately and stay saved on this device.</p>
          {theme === "blueprint" && (
            <p className="settings-blueprint-note" role="note">
              Stylized drafting look; some secondary text is below WCAG AA contrast. Use Dark or Light for full accessibility.
            </p>
          )}

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
              setSaveMessage("");
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
              setSaveMessage("");
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
          {saveError.length > 0 && <div className="settings-error" role="alert"><CircleAlert size={14} />{saveError}</div>}
          {saveMessage.length > 0 && <div className="settings-success" role="status"><Check size={14} />{saveMessage}</div>}

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
          <button className="settings-cancel-button" type="button" onClick={onClose}>Close</button>
          <button
            className="settings-save-button"
            type="button"
            onClick={() => { void save(); }}
            disabled={panelState.kind !== "ready" || saving}
          >
            <Check size={14} />{saving ? "Saving…" : "Save editor preference"}
          </button>
        </footer>
      </section>
    </div>
  );
}
