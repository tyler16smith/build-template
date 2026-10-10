import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Combobox, filterComboboxOptions, type ComboboxOption } from "../src/components/combobox";

const options: ComboboxOption[] = [
  {
    value: "cogs",
    label: "5000 · Cost of goods sold",
    keywords: ["5000", "Cost of goods sold"],
    group: "Expenses",
  },
  {
    value: "software",
    label: "6310 · Software and web services",
    keywords: ["6310", "Software and web services"],
    group: "Expenses",
  },
  { value: "sales", label: "4000 · Sales", keywords: ["4000", "Sales"], group: "Income" },
];

describe("filterComboboxOptions", () => {
  it("returns every option in order when the query is blank", () => {
    expect(filterComboboxOptions(options, "  ").map((option) => option.value)).toEqual([
      "cogs",
      "software",
      "sales",
    ]);
  });

  it("ranks a prefix match ahead of a substring match", () => {
    const ranked = filterComboboxOptions(
      [
        { value: "sub", label: "Profile overview" },
        { value: "pre", label: "Overview" },
      ],
      "over",
    );
    expect(ranked.map((option) => option.value)).toEqual(["pre", "sub"]);
  });

  it("matches keywords without regard to case", () => {
    expect(filterComboboxOptions(options, "SOFTWARE").map((option) => option.value)).toEqual([
      "software",
    ]);
  });

  it("matches a code keyword that is only a prefix of the label", () => {
    expect(filterComboboxOptions(options, "631").map((option) => option.value)).toEqual([
      "software",
    ]);
  });

  it("drops options that do not match the label or keywords", () => {
    expect(filterComboboxOptions(options, "payroll")).toEqual([]);
  });

  it("keeps relative order when two options rank the same", () => {
    const ranked = filterComboboxOptions(
      [
        { value: "a", label: "Board alpha" },
        { value: "b", label: "Board beta" },
      ],
      "board",
    );
    expect(ranked.map((option) => option.value)).toEqual(["a", "b"]);
  });
});

describe("Combobox", () => {
  it("shows the selected label in a closed combobox", () => {
    const html = renderToStaticMarkup(
      <Combobox
        aria-label="Account"
        value="software"
        options={options}
        placeholder="Choose an account"
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("6310 · Software and web services");
    expect(html).toContain('aria-label="Clear"');
  });
});
