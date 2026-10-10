import { describe, expect, it } from "vitest";
import { filterCommandItems, type CommandItem } from "../src/components/command";

const items: CommandItem[] = [
  { id: "overview", group: "Pages", label: "Overview", keywords: ["home"] },
  { id: "profile", group: "Pages", label: "Financial Profile" },
  { id: "theme", group: "Actions", label: "Toggle theme", keywords: ["dark", "light"] },
];

describe("filterCommandItems", () => {
  it("returns every item in order when the query is blank", () => {
    expect(filterCommandItems(items, "  ").map((item) => item.id)).toEqual([
      "overview",
      "profile",
      "theme",
    ]);
  });

  it("ranks a prefix match ahead of a substring match", () => {
    const ranked = filterCommandItems(
      [
        { id: "sub", group: "Pages", label: "Profile overview" },
        { id: "pre", group: "Pages", label: "Overview" },
      ],
      "over",
    );
    expect(ranked.map((item) => item.id)).toEqual(["pre", "sub"]);
  });

  it("matches keywords without regard to case", () => {
    expect(filterCommandItems(items, "DARK").map((item) => item.id)).toEqual(["theme"]);
  });

  it("drops items that do not match the label or keywords", () => {
    expect(filterCommandItems(items, "notifications")).toEqual([]);
  });

  it("keeps relative order when two items rank the same", () => {
    const ranked = filterCommandItems(
      [
        { id: "a", group: "Pages", label: "Board alpha" },
        { id: "b", group: "Pages", label: "Board beta" },
      ],
      "board",
    );
    expect(ranked.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
