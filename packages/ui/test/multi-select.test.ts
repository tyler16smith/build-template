import { describe, expect, it } from "vitest";
import { inCommandScope, searchAllHref } from "../src/components/command";
import { multiSelectSummary, toggleMultiSelect } from "../src/components/multi-select";

const options = [
  { value: "forms", label: "Forms" },
  { value: "crm", label: "CRM" },
  { value: "books", label: "Books" },
];

describe("toggleMultiSelect", () => {
  it("adds and removes a choice", () => {
    expect(toggleMultiSelect(["forms"], "crm", true)).toEqual(["forms", "crm"]);
    expect(toggleMultiSelect(["forms", "crm"], "forms", true)).toEqual(["crm"]);
  });

  it("falls back to all when the last choice is cleared", () => {
    expect(toggleMultiSelect(["forms"], "forms", true)).toEqual([]);
  });

  it("clears every choice when all is picked", () => {
    expect(toggleMultiSelect(["forms", "crm"], "\u0000all", true)).toEqual([]);
  });
});

describe("multiSelectSummary", () => {
  it("names one choice, or the first and how many more", () => {
    expect(multiSelectSummary([], options, "All")).toBe("All");
    expect(multiSelectSummary(["crm"], options, "All")).toBe("CRM");
    expect(multiSelectSummary(["crm", "books"], options, "All")).toBe("CRM +1");
  });
});

describe("inCommandScope", () => {
  const here = { id: "a", group: "Pages", label: "Forms" };
  const there = { ...here, scope: "crm" };
  it("puts unscoped items in the current scope", () => {
    expect(inCommandScope(here, ["forms"], "forms")).toBe(true);
    expect(inCommandScope(there, ["forms"], "forms")).toBe(false);
  });

  it("shows everything when nothing is chosen", () => {
    expect(inCommandScope(there, [], "forms")).toBe(true);
  });
});

describe("searchAllHref", () => {
  it("adds the query parameter, keeping any existing search and hash", () => {
    expect(searchAllHref("https://crm.example.com", "acme co")).toBe(
      "https://crm.example.com?search-all=acme%20co",
    );
    expect(searchAllHref("/b/acme?tab=1#top", "x")).toBe("/b/acme?tab=1&search-all=x#top");
  });
});
