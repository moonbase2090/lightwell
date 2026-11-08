export interface SourceTargetRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** The visible declaration range for a source target, clamped to the loaded document. */
export function sourceTargetRange({
  content,
  line,
  column,
}: {
  readonly content: string;
  readonly line: number;
  readonly column: number;
}): SourceTargetRange {
  const lines = content.split(/\r\n|\r|\n/);
  const lineNumber = Math.min(Math.max(1, line), lines.length);
  const endColumn = (lines[lineNumber - 1]?.length ?? 0) + 1;
  const startColumn = Math.min(Math.max(1, column), endColumn);
  return {
    startLineNumber: lineNumber,
    startColumn,
    endLineNumber: lineNumber,
    endColumn,
  };
}
