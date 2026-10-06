import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { clampPaneSize, readPaneSize, writePaneSize, type PaneSizeStorage } from "./splitter-layout.js";

const handleSize = 8;
const keyboardStep = 24;

type SplitAxis = "x" | "y";

interface ActiveDrag {
  readonly pointerId: number;
  readonly startCoordinate: number;
  readonly startSize: number;
}

export default function Splitter({
  projectId,
  splitterId,
  label,
  axis,
  defaultRatio,
  minimumFirst,
  minimumSecond,
  first,
  second,
  className = "",
}: {
  readonly projectId: string;
  readonly splitterId: string;
  readonly label: string;
  readonly axis: SplitAxis;
  readonly defaultRatio: number;
  readonly minimumFirst: number;
  readonly minimumSecond: number;
  readonly first: ReactNode;
  readonly second: ReactNode;
  readonly className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const requestedSizeRef = useRef<number | null>(null);
  const [availableSize, setAvailableSize] = useState(0);
  const [requestedSize, setRequestedSize] = useState<number | null>(() => readCurrentSize(projectId, splitterId));
  const [dragging, setDragging] = useState(false);
  const ratio = Number.isFinite(defaultRatio) ? Math.min(0.95, Math.max(0.05, defaultRatio)) : 0.5;
  const defaultSize = availableSize * ratio;
  const displayedSize = clampPaneSize(requestedSize ?? defaultSize, availableSize, minimumFirst, minimumSecond);
  const minimumSize = clampPaneSize(0, availableSize, minimumFirst, minimumSecond);
  const maximumSize = clampPaneSize(availableSize, availableSize, minimumFirst, minimumSecond);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    const measure = () => {
      const extent = axis === "x" ? element.clientWidth : element.clientHeight;
      setAvailableSize(Math.max(0, extent - handleSize));
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [axis]);

  useEffect(() => {
    const restored = readCurrentSize(projectId, splitterId);
    requestedSizeRef.current = restored;
    setRequestedSize(restored);
  }, [projectId, splitterId]);

  const updateSize = (size: number, persist: boolean) => {
    requestedSizeRef.current = size;
    setRequestedSize(size);
    if (persist) persistSize(projectId, splitterId, size);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const size = requestedSizeRef.current;
    if (size !== null) persistSize(projectId, splitterId, size);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const coordinate = axis === "x" ? event.clientX : event.clientY;
    dragRef.current = { pointerId: event.pointerId, startCoordinate: coordinate, startSize: displayedSize };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const coordinate = axis === "x" ? event.clientX : event.clientY;
    const size = clampPaneSize(
      drag.startSize + coordinate - drag.startCoordinate,
      availableSize,
      minimumFirst,
      minimumSecond,
    );
    updateSize(size, false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decrement = axis === "x" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const increment = axis === "x" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!decrement && !increment) return;
    event.preventDefault();
    const step = event.shiftKey ? keyboardStep / 4 : keyboardStep;
    const delta = decrement ? -step : step;
    const next = clampPaneSize(displayedSize + delta, availableSize, minimumFirst, minimumSecond);
    updateSize(next, true);
  };

  const resetSize = () => {
    const next = clampPaneSize(defaultSize, availableSize, minimumFirst, minimumSecond);
    updateSize(next, true);
  };

  return (
    <div ref={containerRef} className={`splitter splitter-${axis === "x" ? "horizontal" : "vertical"} ${className}${dragging ? " is-dragging" : ""}`}>
      <div className="splitter-pane splitter-pane-first" style={{ flexBasis: `${displayedSize}px` }}>{first}</div>
      <div
        className="splitter-handle"
        role="separator"
        aria-label={label}
        aria-orientation={axis === "x" ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(minimumSize)}
        aria-valuemax={Math.round(maximumSize)}
        aria-valuenow={Math.round(displayedSize)}
        aria-valuetext={`${Math.round(displayedSize)} pixels`}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onKeyDown={handleKeyDown}
        onDoubleClick={resetSize}
      />
      <div className="splitter-pane splitter-pane-second">{second}</div>
    </div>
  );
}

function readCurrentSize(projectId: string, splitterId: string): number | null {
  const storage = getStorage();
  return storage === null ? null : readPaneSize(storage, projectId, splitterId);
}

function persistSize(projectId: string, splitterId: string, size: number): void {
  const storage = getStorage();
  if (storage !== null) writePaneSize(storage, projectId, splitterId, size);
}

function getStorage(): PaneSizeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
