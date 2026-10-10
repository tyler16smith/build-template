import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/components/button";
import { isSubmitShortcut, submitShortcutLabel } from "../src/lib/submit-shortcut";

const enter = {
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  repeat: false,
};

describe("isSubmitShortcut", () => {
  it("uses ⌘ on Apple platforms and Ctrl everywhere else", () => {
    expect(isSubmitShortcut({ ...enter, metaKey: true }, true)).toBe(true);
    expect(isSubmitShortcut({ ...enter, ctrlKey: true }, true)).toBe(false);
    expect(isSubmitShortcut({ ...enter, ctrlKey: true }, false)).toBe(true);
    expect(isSubmitShortcut({ ...enter, metaKey: true }, false)).toBe(false);
  });

  it("ignores plain Enter, extra modifiers and IME composition", () => {
    expect(isSubmitShortcut(enter, true)).toBe(false);
    expect(isSubmitShortcut({ ...enter, metaKey: true, shiftKey: true }, true)).toBe(false);
    expect(isSubmitShortcut({ ...enter, ctrlKey: true, altKey: true }, false)).toBe(false);
    expect(isSubmitShortcut({ ...enter, metaKey: true, isComposing: true }, true)).toBe(false);
    expect(isSubmitShortcut({ ...enter, key: "a", metaKey: true }, true)).toBe(false);
  });

  it("labels the chord for the platform", () => {
    expect(submitShortcutLabel(true)).toBe("⌘↵");
    expect(submitShortcutLabel(false)).toBe("Ctrl+Enter");
  });
});

describe("Button shortcut markers", () => {
  it("marks its variant so the shortcut can find the primary button", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('data-variant="primary"');
    expect(renderToStaticMarkup(<Button variant="ghost">Cancel</Button>)).toContain(
      'data-variant="ghost"',
    );
  });

  it("passes an explicit opt-in or opt-out through", () => {
    expect(
      renderToStaticMarkup(
        <Button variant="destructive" submitShortcut>
          Delete
        </Button>,
      ),
    ).toContain('data-submit-shortcut="true"');
    expect(renderToStaticMarkup(<Button submitShortcut={false}>Save</Button>)).toContain(
      'data-submit-shortcut="false"',
    );
    expect(renderToStaticMarkup(<Button>Save</Button>)).not.toContain("data-submit-shortcut");
  });

  it("draws the loading spinner in the button's text color", () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain("text-current");
    expect(html).not.toContain("text-foreground/55");
  });
});
