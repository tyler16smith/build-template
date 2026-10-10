import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatSteps } from "../src/components/chat";
import { formatElapsed, reasoningCover, shortUrl, stepCover } from "../src/lib/chat";

describe("chat helpers", () => {
  it("turns a running tool's title into progress, and leaves the rest alone", () => {
    expect(stepCover("Draft an app change", "active")).toBe("Drafting an app change");
    expect(stepCover("List cards", "active")).toBe("Listing cards");
    expect(stepCover("Get board", "active")).toBe("Getting board");
    expect(stepCover("Create card", "active")).toBe("Creating card");
    expect(stepCover("Card details", "active")).toBe("Card details");
    expect(stepCover("Draft an app change", "done")).toBe("Draft an app change");
  });

  it("uses the model's latest bold title as the reasoning cover", () => {
    expect(reasoningCover("**Structuring a response**\n\nI want to…")).toBe(
      "Structuring a response",
    );
    expect(reasoningCover("**Reading the board**\nok\n\n**Checking due dates**\nhm")).toBe(
      "Checking due dates",
    );
    expect(reasoningCover("Just thinking out loud")).toBe("Thinking");
  });

  it("formats elapsed time and shortens long URLs", () => {
    expect(formatElapsed(400)).toBe("1s");
    expect(formatElapsed(6_200)).toBe("6s");
    expect(formatElapsed(102_000)).toBe("1m 42s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(shortUrl("https://www.acme.example/b/1")).toBe("acme.example/b/1");
    expect(
      shortUrl("https://custombase.app/b/acme-2/apps/app_0mumjcx13wdpvg3iql6nb/builds/bld_0mum"),
    ).toBe("custombase.app/…/bld_0mum");
  });
});

describe("ChatSteps", () => {
  const steps = [
    { id: "a", cover: "Structuring a response", state: "done" as const, detail: "Plan it" },
    { id: "b", cover: "Drafting an app change", state: "active" as const },
  ];

  it("shows the current step shimmering while active, collapsed", () => {
    const html = renderToStaticMarkup(<ChatSteps steps={steps} active />);
    expect(html).toContain("ui-shimmer");
    expect(html).toContain("Drafting an app change");
    expect(html).toContain('aria-expanded="false"');
  });

  it("settles to its summary when finished", () => {
    const html = renderToStaticMarkup(
      <ChatSteps
        steps={steps.map((step) => ({ ...step, state: "done" as const }))}
        active={false}
        summary="Thought for 6s"
      />,
    );
    expect(html).toContain("Thought for 6s");
    expect(html).not.toContain("ui-shimmer");
  });
});
