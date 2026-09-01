import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { WorkspacePane } from "./workspace-layout";

interface PaneResizerProps {
  pane: WorkspacePane;
  resizerClass: string;
  ariaLabel: string;
  ariaControls: string;
  resizing: boolean;
  min: number;
  max: number;
  value: number;
  hidden?: boolean;
  onKeyboardResize: (pane: WorkspacePane, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onBeginResize: (pane: WorkspacePane, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function PaneResizer({
  pane,
  resizerClass,
  ariaLabel,
  ariaControls,
  resizing,
  min,
  max,
  value,
  hidden,
  onKeyboardResize,
  onBeginResize,
  onPointerMove,
  onPointerUp,
}: PaneResizerProps) {
  return (
    <div
      className={`workspace-resizer ${resizerClass} ${resizing ? "is-resizing" : ""}`}
      role="separator"
      tabIndex={hidden ? -1 : 0}
      hidden={hidden}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      aria-valuenow={value}
      onKeyDown={(event) => onKeyboardResize(pane, event)}
      onPointerDown={(event) => onBeginResize(pane, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
    />
  );
}