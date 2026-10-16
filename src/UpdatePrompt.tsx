import { RELEASES_URL, type UpdateDelivery } from "./app-updates.js";

/** Release notes stay on screen until the user installs or dismisses the update. */
export default function UpdatePrompt({
  version,
  notes,
  delivery,
  installing,
  onInstall,
  onClose,
}: {
  readonly version: string;
  readonly notes: string;
  readonly delivery: Exclude<UpdateDelivery, "unavailable">;
  readonly installing: boolean;
  readonly onInstall: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="settings-backdrop">
      <section className="editor-settings-panel update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header className="settings-panel-header">
          <div>
            <h2 id="update-title">Update available</h2>
            <p>Version {version}</p>
          </div>
        </header>
        <div className="settings-panel-body">
          <h3 className="settings-section-title">Release notes</h3>
          <pre className="update-notes">{notes.length > 0 ? notes : "No release notes for this version."}</pre>
          {delivery === "manual" && (
            <p className="settings-help">This package cannot replace itself. Download the new release and install it the same way you installed this one.</p>
          )}
        </div>
        <footer className="settings-panel-footer">
          <button className="settings-cancel-button" type="button" onClick={onClose} disabled={installing}>Not now</button>
          {delivery === "integrated" ? (
            <button className="settings-save-button" type="button" onClick={onInstall} disabled={installing}>
              {installing ? "Installing…" : "Install update"}
            </button>
          ) : (
            <a className="settings-save-button update-download" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">Download update</a>
          )}
        </footer>
      </section>
    </div>
  );
}
