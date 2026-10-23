import { Suspense, lazy } from "react";
import { ArrowUpRight, CircleAlert, LoaderCircle, StickyNote, X } from "lucide-react";
import type { BlockDiffDocument, SourceFileDocument } from "./map-source.js";
import type { ResolvedTheme } from "./theme.js";
import type { TextSize } from "./type-scale.js";

const SourceCodeEditor = lazy(() => import("./SourceCodeEditor.js"));
const SourceDiffEditor = lazy(() => import("./SourceDiffEditor.js"));

/** A commit's diff for the inspected block, shown instead of the plain source. */
export type DiffInspectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly document: BlockDiffDocument }
  | { readonly kind: "error"; readonly message: string };

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
  noteText,
  noteStale,
  wordWrap,
  wordWrapShortcut,
  onToggleWordWrap,
  onLineContextMenu,
  onGoToDefinition,
  diff,
  codeSize,
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
  /** The block's saved project note, shown above the source. */
  readonly noteText?: string;
  readonly noteStale?: boolean;
  readonly wordWrap: boolean;
  readonly wordWrapShortcut: string;
  readonly onToggleWordWrap: () => void;
  readonly onLineContextMenu?: (line: number, x: number, y: number) => void;
  readonly onGoToDefinition?: (word: string) => void;
  /** When set, the panel shows this commit diff instead of the current source. */
  readonly diff?: DiffInspectionState;
  /** Source text size in pixels. */
  readonly codeSize: TextSize["code"];
}) {
  return (
    <aside className="source-inspector" aria-label={`Source inspector for ${title}`}>
      <header className="source-inspector-header">
        <div className="source-inspector-title">
          <span className="inspector-kicker">{diff === undefined ? "READ-ONLY SOURCE" : diff.kind === "ready" ? `COMMIT ${diff.document.commit.shortId}` : "COMMIT DIFF"}</span>
          <h2>{title}</h2>
          {diff?.kind === "ready" ? <code title={diff.document.path}>{diff.document.path}</code> : inspection.kind === "ready" && <code title={inspection.document.path}>{inspection.document.path}</code>}
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
      {noteText !== undefined && (
        <section className="block-note-card inspector-note" aria-label="Project note">
          <div className="block-note-header">
            <span><StickyNote size={12} /> PROJECT NOTE</span>
            {onAddNote !== undefined && <button type="button" className="block-note-edit" onClick={onAddNote}>Edit</button>}
          </div>
          <p className="block-note-text">{noteText}</p>
          {noteStale === true && (
            <div className="block-note-stale"><CircleAlert size={12} /> Code changed since this note was written.</div>
          )}
        </section>
      )}

      <div className="source-inspector-content">
        {diff !== undefined && diff.kind === "loading" && (
          <div className="inspector-state"><LoaderCircle size={16} className="inspector-spinner" />Loading commit diff…</div>
        )}
        {diff !== undefined && diff.kind === "error" && (
          <div className="inspector-state inspector-error-state" role="alert"><CircleAlert size={16} />{diff.message}</div>
        )}
        {diff !== undefined && diff.kind === "ready" && (
          <Suspense fallback={<div className="inspector-state"><LoaderCircle size={16} className="inspector-spinner" />Loading diff viewer…</div>}>
            <SourceDiffEditor
              original={diff.document.original}
              modified={diff.document.modified}
              path={diff.document.path}
              line={diff.document.line}
              originalLine={diff.document.originalLine}
              theme={theme}
              fontSize={codeSize}
            />
          </Suspense>
        )}
        {diff === undefined && inspection.kind === "loading" && (
          <div className="inspector-state"><LoaderCircle size={16} className="inspector-spinner" />Loading source…</div>
        )}
        {diff === undefined && inspection.kind === "error" && (
          <div className="inspector-state inspector-error-state" role="alert"><CircleAlert size={16} />{inspection.message}</div>
        )}
        {diff === undefined && inspection.kind === "ready" && (
          <Suspense fallback={<div className="inspector-state"><LoaderCircle size={16} className="inspector-spinner" />Loading code inspector…</div>}>
            <SourceCodeEditor
              content={inspection.document.content}
              line={inspection.document.line}
              column={inspection.document.column}
              path={inspection.document.path}
              theme={theme}
              wordWrap={wordWrap}
              wordWrapShortcut={wordWrapShortcut}
              onToggleWordWrap={onToggleWordWrap}
              fontSize={codeSize}
              {...(onLineContextMenu === undefined ? {} : { onLineContextMenu })}
              {...(onGoToDefinition === undefined ? {} : { onGoToDefinition })}
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
