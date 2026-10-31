import { useEffect, useState } from "react";
import { CircleAlert, FolderOpen, LoaderCircle, Package, RefreshCw, Trash2, X } from "lucide-react";
import {
  REPOSITORY_LANGUAGE_PACK_CATALOG,
  catalogPackAction,
  catalogPackStatus,
  type RepositoryLanguagePackCatalog,
} from "./language-pack-catalog.js";
import type {
  InvalidLanguagePackEntry,
  LanguagePackCatalogSnapshot,
  LanguagePackSource,
  LoadedLanguagePackEntry,
} from "./language-pack-source.js";

type CatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: LanguagePackCatalogSnapshot }
  | { readonly kind: "error"; readonly message: string };

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
}

function originLabel(origin: LoadedLanguagePackEntry["origin"]): string {
  if (origin === "builtin") return "Built in";
  if (origin === "workspace") return "Workspace";
  return "Installed";
}

function selectors(pack: LoadedLanguagePackEntry): string {
  const values = [
    ...pack.manifest.extensions,
    ...pack.manifest.basenames,
    ...pack.manifest.basenamePrefixes.map((prefix) => `${prefix}*`),
  ];
  return values.length === 0 ? "No file selectors" : values.join(", ");
}

export function LanguagePackCatalogView({
  snapshot,
  repositoryCatalog,
  dismissedErrors,
  busyId,
  onInstall,
  onRemove,
  onDismissError,
}: {
  readonly snapshot: LanguagePackCatalogSnapshot;
  readonly repositoryCatalog: RepositoryLanguagePackCatalog;
  readonly dismissedErrors: ReadonlySet<string>;
  readonly busyId: string | null;
  readonly onInstall: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onDismissError: (id: string) => void;
}) {
  const loaded = snapshot.entries.filter((entry): entry is LoadedLanguagePackEntry => entry.kind === "loaded");
  const errors = snapshot.entries.filter((entry): entry is InvalidLanguagePackEntry => (
    entry.kind === "error" && !dismissedErrors.has(entry.errorId)
  ));
  return (
    <>
      <div className="language-pack-list" aria-label="Loaded language packs">
        {loaded.map((pack) => (
          <article className="language-pack-row" key={`${pack.origin}:${pack.id}`}>
            <Package size={15} aria-hidden="true" />
            <div className="language-pack-copy">
              <div className="language-pack-name"><code>{pack.id}</code><span>v{pack.packVersion}</span></div>
              <p>{selectors(pack)}</p>
            </div>
            <span className={`language-pack-status ${pack.origin}`}>{originLabel(pack.origin)}</span>
            {pack.origin === "user" && (
              <button
                className="language-pack-icon-action"
                type="button"
                aria-label={`Uninstall ${pack.id}`}
                disabled={busyId !== null}
                onClick={() => onRemove(pack.id)}
              ><Trash2 size={14} /></button>
            )}
          </article>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="language-pack-errors" aria-label="Language pack errors">
          {errors.map((entry) => (
            <div className="language-pack-error" role="alert" key={entry.errorId}>
              <CircleAlert size={15} />
              <div><strong>{entry.code}</strong><p>{entry.message}</p></div>
              <button type="button" aria-label="Clear language pack error" onClick={() => onDismissError(entry.errorId)}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      <h4 className="language-pack-subtitle">Available from this Lightwell build</h4>
      <div className="language-pack-list" aria-label="Available language packs">
        {repositoryCatalog.packs.map((pack) => {
          const status = catalogPackStatus(pack, loaded);
          const action = catalogPackAction(pack, loaded);
          const busy = busyId === `catalog:${pack.id}`;
          return (
            <article className="language-pack-row catalog" key={pack.id}>
              <Package size={15} aria-hidden="true" />
              <div className="language-pack-copy">
                <div className="language-pack-name"><code>{pack.id}</code><span>v{pack.packVersion}</span></div>
                <p>{pack.description}</p>
                <p className="language-pack-extensions">{pack.extensions.join(", ")}</p>
              </div>
              {action.kind === "none" ? (
                <span className="language-pack-status installed">Installed</span>
              ) : (
                <button
                  className="settings-shortcut-action language-pack-action"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => onInstall(pack.id)}
                >
                  {busy && <LoaderCircle size={13} className="settings-save-spinner" />}
                  {status.kind === "update" ? "Update" : "Install"}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

export default function LanguagePacksSettings({
  source,
  workspaceId,
  repositoryCatalog = REPOSITORY_LANGUAGE_PACK_CATALOG,
}: {
  readonly source: LanguagePackSource;
  readonly workspaceId: string | null;
  readonly repositoryCatalog?: RepositoryLanguagePackCatalog;
}) {
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let unlisten: () => void = () => undefined;
    void source.catalog(workspaceId).then(
      (snapshot) => {
        if (!cancelled) setState((current) => newerCatalogState(current, snapshot));
      },
      (error: unknown) => { if (!cancelled) setState({ kind: "error", message: describeError(error, "Could not load language packs.") }); },
    );
    void source.watch(
      (snapshot) => {
        if (!cancelled) setState((current) => newerCatalogState(current, snapshot));
      },
      (error) => { if (!cancelled) setActionError(describeError(error, "Could not refresh language packs.")); },
    ).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }, (error: unknown) => {
      if (!cancelled) setActionError(describeError(error, "Could not watch language packs."));
    });
    return () => { cancelled = true; unlisten(); };
  }, [source, workspaceId]);

  const replaceSnapshot = (snapshot: LanguagePackCatalogSnapshot) => {
    setState((current) => newerCatalogState(current, snapshot));
    setActionError("");
  };

  const install = async (id: string) => {
    const pack = repositoryCatalog.packs.find((candidate) => candidate.id === id);
    if (pack === undefined || state.kind !== "ready") return;
    const loaded = state.snapshot.entries.filter((entry): entry is LoadedLanguagePackEntry => entry.kind === "loaded");
    const action = catalogPackAction(pack, loaded);
    if (action.kind === "none") return;
    setBusyId(`catalog:${id}`);
    setActionError("");
    try {
      replaceSnapshot(await source.install(action.source, action.replace));
    } catch (error: unknown) {
      setActionError(describeError(error, `Could not ${action.kind} ${id}.`));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Uninstall the ${id} language pack?`)) return;
    setBusyId(`remove:${id}`);
    setActionError("");
    try {
      replaceSnapshot(await source.remove(id));
    } catch (error: unknown) {
      setActionError(describeError(error, `Could not uninstall ${id}.`));
    } finally {
      setBusyId(null);
    }
  };

  const reload = async () => {
    setBusyId("reload");
    setActionError("");
    try {
      replaceSnapshot(await source.reload(workspaceId));
      setDismissedErrors(new Set());
    } catch (error: unknown) {
      setActionError(describeError(error, "Could not reload language packs."));
    } finally {
      setBusyId(null);
    }
  };

  const openDirectory = async () => {
    setActionError("");
    try {
      await source.openDirectory();
    } catch (error: unknown) {
      setActionError(describeError(error, "Could not open the language packs folder."));
    }
  };

  return (
    <section className="language-pack-settings" aria-labelledby="language-pack-settings-title">
      <div className="language-pack-heading">
        <div>
          <h3 className="settings-section-title settings-editor-section" id="language-pack-settings-title">Language packs</h3>
          <p className="settings-help">Packs change file matching and source highlighting without restarting Lightwell.</p>
        </div>
        <div className="language-pack-toolbar">
          <button className="language-pack-icon-action" type="button" aria-label="Open language packs folder" onClick={() => { void openDirectory(); }}><FolderOpen size={14} /></button>
          <button className="language-pack-icon-action" type="button" aria-label="Reload language packs" disabled={busyId !== null} onClick={() => { void reload(); }}><RefreshCw size={14} className={busyId === "reload" ? "settings-save-spinner" : undefined} /></button>
        </div>
      </div>

      {state.kind === "loading" && <div className="settings-status"><LoaderCircle size={14} className="settings-save-spinner" />Loading language packs…</div>}
      {state.kind === "error" && <div className="settings-error" role="alert"><CircleAlert size={14} />{state.message}</div>}
      {state.kind === "ready" && (
        <LanguagePackCatalogView
          snapshot={state.snapshot}
          repositoryCatalog={repositoryCatalog}
          dismissedErrors={dismissedErrors}
          busyId={busyId}
          onInstall={(id) => { void install(id); }}
          onRemove={(id) => { void remove(id); }}
          onDismissError={(id) => setDismissedErrors((current) => new Set([...current, id]))}
        />
      )}
      {actionError.length > 0 && (
        <div className="settings-error language-pack-action-error" role="alert">
          <CircleAlert size={14} />
          <span>{actionError}</span>
          <button type="button" aria-label="Clear language pack action error" onClick={() => setActionError("")}><X size={14} /></button>
        </div>
      )}
    </section>
  );
}

function newerCatalogState(current: CatalogState, snapshot: LanguagePackCatalogSnapshot): CatalogState {
  if (current.kind === "ready" && current.snapshot.revision > snapshot.revision) return current;
  return { kind: "ready", snapshot };
}
