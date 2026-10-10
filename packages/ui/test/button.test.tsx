import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/components/button";

describe("Button", () => {
  it("renders its child element in place of a button with asChild", () => {
    const html = renderToStaticMarkup(
      <Button asChild variant="outline">
        <a href="/catalog">Browse the catalog</a>
      </Button>,
    );
    expect(html).toMatch(/^<a [^>]*href="\/catalog"/);
    expect(html).not.toContain("<button");
  });

  it("disables itself and shows a spinner while loading", () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });
});
