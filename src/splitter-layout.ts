export interface PaneSizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function paneSizeStorageKey(projectId: string, splitterId: string): string {
  return `lightwell.split.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(splitterId)}`;
}

export function clampPaneSize(
  requestedSize: number,
  availableSize: number,
  minimumFirst: number,
  minimumSecond: number,
): number {
  const available = Number.isFinite(availableSize) ? Math.max(0, availableSize) : 0;
  if (available === 0) return 0;

  let minFirst = Number.isFinite(minimumFirst) ? Math.max(0, minimumFirst) : 0;
  let minSecond = Number.isFinite(minimumSecond) ? Math.max(0, minimumSecond) : 0;
  if (minFirst + minSecond > available) {
    minFirst = available / 2;
    minSecond = available - minFirst;
  }

  const lowerBound = minFirst;
  const upperBound = Math.max(lowerBound, available - minSecond);
  const requested = Number.isFinite(requestedSize) ? requestedSize : lowerBound;
  return Math.min(upperBound, Math.max(lowerBound, requested));
}

export function readPaneSize(storage: PaneSizeStorage, projectId: string, splitterId: string): number | null {
  try {
    const stored = storage.getItem(paneSizeStorageKey(projectId, splitterId));
    if (stored === null) return null;
    const size = Number(stored);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

export function writePaneSize(storage: PaneSizeStorage, projectId: string, splitterId: string, size: number): boolean {
  if (!Number.isFinite(size) || size <= 0) return false;
  try {
    storage.setItem(paneSizeStorageKey(projectId, splitterId), String(size));
    return true;
  } catch {
    return false;
  }
}
