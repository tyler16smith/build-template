import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { SHEET_INSET_PX, SheetContent } from "./overlay";

export const SIDE_PANEL_MIN_WIDTH = 320;
export const SIDE_PANEL_MAX_WIDTH = 640;
export const SIDE_PANEL_DEFAULT_WIDTH = 400;
/** Matches Tailwind's `md` breakpoint: below it the panel overlays instead of pushing the page. */
export const SIDE_PANEL_DESKTOP_QUERY = "(min-width: 768px)";

export type SidePanelLayout = "push" | "overlay";

export function clampSidePanelWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDE_PANEL_DEFAULT_WIDTH;
  return Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(width)));
}

/** A panel anchored on the right grows when its left edge is dragged left. */
export function sidePanelWidthAfterDrag(
  startWidth: number,
  startX: number,
  currentX: number,
): number {
  return clampSidePanelWidth(startWidth + (startX - currentX));
}

export function readSidePanelWidth(
  storage: { getItem(key: string): string | null } | null,
  key: string,
  fallback = SIDE_PANEL_DEFAULT_WIDTH,
): number {
  const resolved = clampSidePanelWidth(fallback);
  if (!storage) return resolved;
  const stored = Number(storage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? clampSidePanelWidth(stored) : resolved;
}

export function writeSidePanelWidth(
  storage: { setItem(key: string, value: string): void } | null,
  key: string,
  width: number,
): void {
  storage?.setItem(key, String(clampSidePanelWidth(width)));
}

export function sidePanelLayout(matchesDesktop: boolean): SidePanelLayout {
  return matchesDesktop ? "push" : "overlay";
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembers a dragged width. `onResize` is called live, and with `commit` when the drag ends. */
export function useSidePanelWidth(storageKey: string, fallback = SIDE_PANEL_DEFAULT_WIDTH) {
  const [width, setWidth] = useState(() =>
    readSidePanelWidth(browserStorage(), storageKey, fallback),
  );
  const onResize = useCallback(
    (next: number, commit: boolean) => {
      const clamped = clampSidePanelWidth(next);
      setWidth(clamped);
      if (commit) writeSidePanelWidth(browserStorage(), storageKey, clamped);
    },
    [storageKey],
  );
  return { width, onResize };
}

/**
 * The left edge of a right-hand panel. Dragging left widens it, between the side-panel limits,
 * and the arrow keys do the same. The highlight is the only visible control.
 */
export function SidePanelResizeHandle({
  label,
  width,
  onResize,
  className,
}: {
  label: string;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuemin={SIDE_PANEL_MIN_WIDTH}
      aria-valuemax={SIDE_PANEL_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      className={cn(
        "absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none",
        "hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = width;
        const move = (pointer: PointerEvent) => {
          onResize(sidePanelWidthAfterDrag(startWidth, startX, pointer.clientX), false);
        };
        const stop = (pointer: PointerEvent) => {
          onResize(sidePanelWidthAfterDrag(startWidth, startX, pointer.clientX), true);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
      }}
      onKeyDown={(event) => {
        const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
        if (!delta) return;
        event.preventDefault();
        onResize(clampSidePanelWidth(width + delta), true);
      }}
    />
  );
}

function useDesktopLayout(): boolean {
  const [desktop, setDesktop] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia(SIDE_PANEL_DESKTOP_QUERY).matches;
  });
  useEffect(() => {
    const query = window.matchMedia(SIDE_PANEL_DESKTOP_QUERY);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return desktop;
}

/**
 * A panel on the right of the page. On a wide screen it sits in the layout, 5px in from the
 * edges with rounded corners, and narrows the page; on a small screen it becomes the sheet
 * overlay, because there is no room to push the page aside. Opening and closing eases the width
 * (or slides the sheet in from the right) instead of popping. The width is dragged from the
 * left edge and remembered.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  storageKey = "side-panel-width",
  presentation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode | ((layout: SidePanelLayout) => ReactNode);
  storageKey?: string;
  /** Forces push or overlay. Omit it to follow the viewport. */
  presentation?: SidePanelLayout;
}) {
  const desktop = useDesktopLayout();
  const layout = presentation ?? sidePanelLayout(desktop);
  const { width, onResize } = useSidePanelWidth(storageKey);
  const body = typeof children === "function" ? children(layout) : children;
  if (layout === "overlay") {
    return (
      <div data-layout="overlay" className="contents">
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
          <SheetContent title={title} description={description} className="max-w-lg" flush>
            {body}
          </SheetContent>
        </DialogPrimitive.Root>
      </div>
    );
  }
  return (
    <aside
      aria-label={title}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      style={{ width: open ? width + SHEET_INSET_PX * 2 : 0 }}
      className={cn(
        "ui-side-panel-width sticky top-shell z-20 flex h-shell shrink-0 justify-end self-start overflow-hidden",
        !open && "pointer-events-none",
      )}
    >
      <div
        data-submit-scope=""
        className="relative m-[5px] flex h-[calc(100%-10px)] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface"
        style={{ width }}
      >
        {open ? <SidePanelResizeHandle label={title} width={width} onResize={onResize} /> : null}
        {body}
      </div>
    </aside>
  );
}
