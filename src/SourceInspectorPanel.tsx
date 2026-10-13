import { Suspense, lazy } from "react";
import { ArrowUpRight, CircleAlert, LoaderCircle, StickyNote, X } from "lucide-react";
import type { SourceFileDocument } from "./map-source.js";
import type { ResolvedTheme } from "./theme.js";

const SourceCodeEditor = lazy(() => import("./SourceCodeEditor.js"));

export type SourceInspectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly document: SourceFileDocument }
  | { readonly kind: "error"; readonly message: string };

export default function SourceInspectorPanel({
  title,
  inspection,
  theme,
  openingEditor,
  editorError,
  onOpenInEditor,
  onClose,
  noteAction,
  onAddNote,
  onLineContextMenu,
}: {
  readonly title: string;
  readonly inspection: SourceInspectionState;
  readonly theme: ResolvedTheme;
  readonly openingEditor: boolean;
  readonly editorError: string;
  readonly onOpenInEditor: () => void;
  readonly onClose: () => void;
  /** Label of the note button for this block, or undefined when notes are unavailable. */
  readonly noteAction?: "Add note" | "Edit note";
  readonly onAddNote?: () => void;
  readonly onLineContextMenu?: (line: number, x: number, y: number) => void;
}) {
  return (
    <aside className="source-inspector" aria-label={`Source inspector for ${title}`}>
      <header className="source-inspector-header">
        <div className="source-inspector-title">
          <span className="inspector-kicker">READ-ONLY SOURCE</span>
          <h2>{title}</h2>
          {inspection.kind === "ready" && <code title={inspection.document.path}>{inspection.document.path}</code>}
        </div>
        <button className="icon-button inspector-close" type="button" aria-label="Close source inspector" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <button
        className="open-in-editor-button"
        type="button"
        onClick={onOpenInEditor}
        disabled={inspection.kind !== "ready" || openingEditor}
      >
        <ArrowUpRight size={15} />{openingEditor ? "Opening editor…" : "Open in editor"}
      </button>
      {noteAction !== undefined && onAddNote !== undefined && (
        <button className="inspector-add-note-button" type="button" onClick={onAddNote} title={`${noteAction} (N) · right-click a line for more`}>
          <StickyNote size={14} />{noteAction}<kbd>N</kbd>
        </button>
      )}
      {editorError.length > 0 && <div className="inspector-error" role="alert"><CircleAlert size={14} />{editorError}</div>}

      <div className="source-inspector-content">
        {inspection.kind === "loading" && (
          <div className="inspector-state"><LoaderCircle size={16} className="inspector-spinner" />Loading source…</div>
        )}
        {inspection.kind === "error" && (
          <div className="inspector-state inspector-error-state" role="alert"><CircleAlert size={16} />{inspection.message}</div>
        )}
        {inspection.kind === "ready" && (
          <Suspense fallback={<div className="inspector-state"><LoaderCircle size={16} className="inspector-spinner" />Loading code inspector…</div>}>
            <SourceCodeEditor
              content={inspection.document.content}
              line={inspection.document.line}
              column={inspection.document.column}
              path={inspection.document.path}
              theme={theme}
              {...(onLineContextMenu === undefined ? {} : { onLineContextMenu })}
            />
          </Suspense>
        )}
      </div>
      {inspection.kind === "ready" && (
        <footer className="inspector-position">LINE {inspection.document.line} <i /> COLUMN {inspection.document.column}</footer>
      )}
    </aside>
  );
}
