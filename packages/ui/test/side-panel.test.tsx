import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SHEET_INSET_PX, sheetPanelClass } from "../src/components/overlay";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SidePanel,
  clampSidePanelWidth,
  readSidePanelWidth,
  sidePanelLayout,
  sidePanelWidthAfterDrag,
  writeSidePanelWidth,
} from "../src/components/side-panel";

describe("side panel width", () => {
  it("clamps a dragged width between 320 and 640", () => {
    expect(clampSidePanelWidth(100)).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(clampSidePanelWidth(900)).toBe(SIDE_PANEL_MAX_WIDTH);
    expect(clampSidePanelWidth(480.4)).toBe(480);
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
  });

  it("widens when the left edge moves left", () => {
    expect(sidePanelWidthAfterDrag(400, 200, 160)).toBe(440);
    expect(sidePanelWidthAfterDrag(400, 200, 800)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("remembers the width", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    };
    expect(readSidePanelWidth(storage, "panel")).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    writeSidePanelWidth(storage, "panel", 510);
    expect(readSidePanelWidth(storage, "panel")).toBe(510);
    writeSidePanelWidth(storage, "panel", 20);
    expect(readSidePanelWidth(storage, "panel")).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(readSidePanelWidth(null, "panel")).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    expect(readSidePanelWidth(null, "panel", 416)).toBe(416);
    expect(readSidePanelWidth(storage, "missing", 416)).toBe(416);
  });
});

describe("side panel layout", () => {
  it("pushes the page on a wide screen and overlays on a small one", () => {
    expect(sidePanelLayout(true)).toBe("push");
    expect(sidePanelLayout(false)).toBe("overlay");
  });

  it("renders a resizable aside when it pushes the page", () => {
    const html = renderToStaticMarkup(
      <SidePanel open onOpenChange={() => undefined} title="Assistant" presentation="push">
        <p>Chat</p>
      </SidePanel>,
    );
    expect(html).toContain("<aside");
    expect(html).toContain('aria-label="Assistant"');
    expect(html).toContain("rounded-xl");
    expect(html).toContain("m-[5px]");
    expect(html).toContain(`style="width:${SIDE_PANEL_DEFAULT_WIDTH + SHEET_INSET_PX * 2}px"`);
    expect(html).toContain('aria-label="Resize Assistant"');
    expect(html).toContain("cursor-col-resize");
    expect(html).toContain('aria-valuemin="320"');
    expect(html).toContain('aria-valuemax="640"');
    expect(html).toContain("Chat");
    expect(html).not.toContain('role="dialog"');
  });

  it("falls back to a sheet overlay on a small screen", () => {
    const html = renderToStaticMarkup(
      <SidePanel open onOpenChange={() => undefined} title="Assistant" presentation="overlay">
        <p>Chat</p>
      </SidePanel>,
    );
    expect(html).toContain('data-layout="overlay"');
    expect(html).not.toContain("<aside");
    expect(html).not.toContain('aria-label="Resize Assistant"');
  });

  it("keeps a closed push panel mounted at zero width", () => {
    const html = renderToStaticMarkup(
      <SidePanel open={false} onOpenChange={() => undefined} title="Assistant" presentation="push">
        <p>Chat</p>
      </SidePanel>,
    );
    expect(html).toContain("<aside");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("inert");
    expect(html).toContain('style="width:0"');
    expect(html).toContain(`style="width:${SIDE_PANEL_DEFAULT_WIDTH}px"`);
    expect(html).toContain("Chat");
    expect(html).not.toContain('aria-label="Resize Assistant"');
  });
});

describe("sheet panel", () => {
  it("slides in from either edge, inset and rounded", () => {
    const right = sheetPanelClass("right");
    expect(right).toContain("right-[5px]");
    expect(right).toContain("top-[5px]");
    expect(right).toContain("bottom-[5px]");
    expect(right).toContain("rounded-xl");
    expect(right).toContain("animate-ui-slide-in-right");
    expect(right).toContain("animate-ui-slide-out-right");

    const left = sheetPanelClass("left", "w-64 max-w-[calc(100%-10px)] bg-surface");
    expect(left).toContain("left-[5px]");
    expect(left).toContain("animate-ui-slide-in-left");
    expect(left).toContain("animate-ui-slide-out-left");
    const classes = left.split(" ");
    expect(classes).toContain("w-64");
    expect(classes).not.toContain("w-[calc(100%-10px)]");
    expect(classes).toContain("bg-surface");
    expect(classes).not.toContain("bg-surface-raised");
    expect(classes).toContain("max-w-[calc(100%-10px)]");
  });
});
