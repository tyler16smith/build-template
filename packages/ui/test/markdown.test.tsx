import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, parseMarkdown } from "../src/components/markdown";

describe("Markdown", () => {
  it("parses the shapes models reply with", () => {
    const blocks = parseMarkdown(
      [
        "## Cards due this week",
        "",
        "You have **3 cards** due:",
        "",
        "1. Homepage copy — *Friday*",
        "2. Logo refresh",
        "   (waiting on the client)",
        "",
        "| Card | Due |",
        "| --- | --- |",
        "| Homepage copy | Fri |",
        "",
        "```",
        "boards.cards.move",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "table", "code"]);
    expect(blocks[2]).toEqual({
      kind: "list",
      ordered: true,
      start: 1,
      items: [
        { text: "Homepage copy — *Friday*", checked: null, children: [] },
        { text: "Logo refresh (waiting on the client)", checked: null, children: [] },
      ],
    });
    expect(blocks[3]).toEqual({
      kind: "table",
      header: ["Card", "Due"],
      rows: [["Homepage copy", "Fri"]],
    });
  });

  it("renders emphasis, code and safe links, and never raw HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown
        source={
          "**Done** — moved `Logo` to [the board](https://acme.example/b/1). <img src=x onerror=alert(1)> [x](javascript:alert(1))"
        }
      />,
    );
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toContain('href="https://acme.example/b/1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("javascript:");
  });

  it("keeps nested, task and loose lists together", () => {
    const [list] = parseMarkdown(
      ["3. Plan", "   - Draft", "   - [x] Review", "", "4. Ship", "   - [ ] Announce"].join("\n"),
    );
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });
    const items = (list as Extract<typeof list, { kind: "list" }>).items;
    expect(items.map((item) => item.text)).toEqual(["Plan", "Ship"]);
    expect(items[0]!.children[0]).toMatchObject({
      kind: "list",
      items: [
        { text: "Draft", checked: null },
        { text: "Review", checked: true },
      ],
    });
    expect(items[1]!.children[0]).toMatchObject({ items: [{ text: "Announce", checked: false }] });
  });

  it("reads fences with a language, rules, and an unclosed fence while streaming", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n```\n\n---\n\n```\nhalf")).toEqual([
      { kind: "code", text: "const a = 1;", lang: "ts" },
      { kind: "rule" },
      { kind: "code", text: "half", lang: "" },
    ]);
  });

  it("autolinks bare URLs without italicising their underscores, in a new tab", () => {
    const url = "https://custombase.app/b/acme-2/apps/app_0mumjcx13wdpvg3iql6nb/builds/bld_0mumq2";
    const html = renderToStaticMarkup(<Markdown source={`Review it here: ${url}.`} />);
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("<em>");
    expect(html).toContain("custombase.app/…/");
    expect(html).toMatch(/<\/a>\.<\/p>/);
  });

  it("keeps snake_case literal and renders strikethrough and images as links", () => {
    const html = renderToStaticMarkup(
      <Markdown
        source={"Use `x` in my_board_name, ~~old~~ and ![chart](https://acme.example/c.png)"}
      />,
    );
    expect(html).not.toContain("<em>");
    expect(html).toContain("<del");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://acme.example/c.png"');
  });
});
