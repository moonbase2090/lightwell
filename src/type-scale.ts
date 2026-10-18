/** Device-wide text sizes. UI and labels are scales. Code is a pixel size. */

export const TEXT_SIZE_STORAGE_KEY = "lightwell.type-scale.v1";

export const UI_SCALE_DEFAULT = 1;
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.1;

export const LABEL_SCALE_DEFAULT = 1;
export const LABEL_SCALE_MIN = 0.8;
export const LABEL_SCALE_MAX = 1.6;
export const LABEL_SCALE_STEP = 0.1;

export const CODE_SIZE_DEFAULT = 13;
export const CODE_SIZE_MIN = 11;
export const CODE_SIZE_MAX = 22;
export const CODE_SIZE_STEP = 1;

/** Connection labels on the map. The previous size was 9px. */
export const EDGE_LABEL_PX = 12;

export type TextSizeAxis = "ui" | "code" | "labels";

export type TextSize = {
  readonly ui: number;
  readonly code: number;
  readonly labels: number;
};

export const DEFAULT_TEXT_SIZE: TextSize = {
  ui: UI_SCALE_DEFAULT,
  code: CODE_SIZE_DEFAULT,
  labels: LABEL_SCALE_DEFAULT,
};

export interface TextSizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function bounds(axis: TextSizeAxis): { readonly min: number; readonly max: number; readonly fallback: number } {
  switch (axis) {
    case "ui":
      return { min: UI_SCALE_MIN, max: UI_SCALE_MAX, fallback: UI_SCALE_DEFAULT };
    case "code":
      return { min: CODE_SIZE_MIN, max: CODE_SIZE_MAX, fallback: CODE_SIZE_DEFAULT };
    case "labels":
      return { min: LABEL_SCALE_MIN, max: LABEL_SCALE_MAX, fallback: LABEL_SCALE_DEFAULT };
    default: {
      const exhaustive: never = axis;
      return exhaustive;
    }
  }
}

/** Snap to a tenth for scales and to a whole pixel for code, then clamp. */
export function clampTextSize(value: number, axis: TextSizeAxis): number {
  const { min, max, fallback } = bounds(axis);
  if (!Number.isFinite(value)) return fallback;
  const snapped = axis === "code" ? Math.round(value) : Math.round(value * 10) / 10;
  if (snapped < min) return min;
  if (snapped > max) return max;
  return snapped;
}

export function stepTextSize(current: number, axis: TextSizeAxis, direction: -1 | 1): number {
  const step = axis === "code" ? CODE_SIZE_STEP : axis === "ui" ? UI_SCALE_STEP : LABEL_SCALE_STEP;
  return clampTextSize(clampTextSize(current, axis) + direction * step, axis);
}

export function parseTextSize(raw: string | null): TextSize {
  if (raw === null || raw.trim() === "") return DEFAULT_TEXT_SIZE;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return DEFAULT_TEXT_SIZE;
    const record = value as { ui?: unknown; code?: unknown; labels?: unknown };
    return {
      ui: typeof record.ui === "number" ? clampTextSize(record.ui, "ui") : UI_SCALE_DEFAULT,
      code: typeof record.code === "number" ? clampTextSize(record.code, "code") : CODE_SIZE_DEFAULT,
      labels: typeof record.labels === "number" ? clampTextSize(record.labels, "labels") : LABEL_SCALE_DEFAULT,
    };
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

export function readTextSize(storage: TextSizeStorage | null): TextSize {
  try {
    return parseTextSize(storage?.getItem(TEXT_SIZE_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

export function writeTextSize(storage: TextSizeStorage | null, size: TextSize): void {
  const stored: TextSize = {
    ui: clampTextSize(size.ui, "ui"),
    code: clampTextSize(size.code, "code"),
    labels: clampTextSize(size.labels, "labels"),
  };
  try {
    storage?.setItem(TEXT_SIZE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The choice still applies for this session when storage is unavailable.
  }
}

export function formatTextSize(value: number, axis: TextSizeAxis): string {
  if (axis === "code") return `${clampTextSize(value, "code")} px`;
  return `${Math.round(clampTextSize(value, axis) * 100)}%`;
}

/** Monaco line height. 11px source used 20px, and other sizes keep that ratio. */
export function codeLineHeight(fontSize: number): number {
  return Math.round(clampTextSize(fontSize, "code") * 20 / 11);
}

export function edgeLabelFontSize(labelScale: number): number {
  return Math.round(EDGE_LABEL_PX * clampTextSize(labelScale, "labels"));
}

export function textSizeVars(size: TextSize): Record<"--lw-ui-scale" | "--lw-label-scale", string> {
  return {
    "--lw-ui-scale": String(clampTextSize(size.ui, "ui")),
    "--lw-label-scale": String(clampTextSize(size.labels, "labels")),
  };
}
