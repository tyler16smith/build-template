import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LightboxImage } from "../src/components/lightbox";

describe("LightboxImage", () => {
  it("opens from a button instead of a link", () => {
    const html = renderToStaticMarkup(
      <LightboxImage src="/shots/board.png" alt="Screenshot of the draft" imgClassName="h-20" />,
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="View Screenshot of the draft"');
    expect(html).toContain('src="/shots/board.png"');
    expect(html).toContain("cursor-zoom-in");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("target=");
  });

  it("can use its own trigger, still pointing at the full image", () => {
    const html = renderToStaticMarkup(
      <LightboxImage src="/files/shot.png" alt="shot.png" className="max-w-48">
        <span>shot.png</span>
      </LightboxImage>,
    );
    expect(html).toContain('aria-label="View shot.png"');
    expect(html).toContain("max-w-48");
    expect(html).toContain(">shot.png<");
    expect(html).not.toContain("<a ");
  });
});
